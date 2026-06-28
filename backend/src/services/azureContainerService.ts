import { ContainerAppsAPIClient } from "npm:@azure/arm-appcontainers";
import { ClientSecretCredential } from "npm:@azure/identity";

const subscriptionId = Deno.env.get("AZURE_SUBSCRIPTION_ID") ?? "";
const resourceGroupName = Deno.env.get("AZURE_RESOURCE_GROUP") ?? "";
const containerAppName = Deno.env.get("AZURE_CONTAINER_APP_NAME") ?? "";
const environmentName = Deno.env.get("AZURE_CONTAINER_ENV_NAME") ?? "";
const clientId = Deno.env.get("AZURE_CLIENT_ID") ?? "";
const clientSecret = Deno.env.get("AZURE_CLIENT_SECRET") ?? "";
const tenantId = Deno.env.get("AZURE_TENANT_ID") ?? "";

// ─── In-memory cache for environment details ────────────────────────────────
// These values (verificationId, fqdn) are static for a given Container App deployment.
// We read them from env vars first (zero latency), fall back to a live ARM call only
// if the env vars are not set, and then cache the result permanently in memory so that
// subsequent calls are always instant regardless of Azure ARM latency.
let _cachedDetails: { verificationId: string; fqdn: string } | null = null;

// Bootstrap the cache immediately from env vars at module load time.
// This is synchronous and costs nothing — no network calls.
(function bootstrapCache() {
  const verificationId = Deno.env.get("AZURE_DOMAIN_VERIFICATION_ID") ?? "";
  const fqdn = Deno.env.get("AZURE_APP_FQDN") ?? "";
  if (verificationId && fqdn) {
    _cachedDetails = { verificationId, fqdn };
    console.log("[AzureContainerService] Loaded domain config from env vars (instant, no ARM call needed).");
  }
})();

let _armClient: ContainerAppsAPIClient | null = null;

function getArmClient(): ContainerAppsAPIClient {
  if (!_armClient) {
    if (!subscriptionId || !clientId || !clientSecret || !tenantId) {
      throw new Error(
        "Azure ARM credentials not fully configured " +
        "(need AZURE_SUBSCRIPTION_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID)"
      );
    }
    // ClientSecretCredential authenticates immediately and deterministically.
    // We do NOT use DefaultAzureCredential here because it tries many auth providers
    // sequentially (including Managed Identity IMDS with a ~60s probe), which causes
    // the Azure Container Apps load balancer to return 503 before authentication completes.
    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    _armClient = new ContainerAppsAPIClient(credential, subscriptionId);
  }
  return _armClient;
}

/**
 * Returns the Azure environment details needed for custom domain setup.
 *
 * PERFORMANCE: This function NEVER blocks on a live Azure ARM API call.
 *   - If AZURE_DOMAIN_VERIFICATION_ID and AZURE_APP_FQDN are set in .env → responds instantly.
 *   - If they are not set → makes a single ARM call, caches the result in memory,
 *     and responds from the cache for all future requests.
 */
export async function getAzureEnvironmentDetails() {
  // Fast path: return from in-memory cache (populated at startup from env vars or
  // from the first-ever live ARM call). This path has zero network I/O.
  if (_cachedDetails) {
    return {
      success: true,
      verificationId: _cachedDetails.verificationId,
      fqdn: _cachedDetails.fqdn,
    };
  }

  // Slow path: env vars not set — make a live ARM call (should only happen once ever).
  // Short-circuit if we don't even have the credentials or resource identifiers.
  if (
    !subscriptionId || !resourceGroupName || !containerAppName ||
    !environmentName || !clientId || !clientSecret || !tenantId
  ) {
    console.warn("[AzureContainerService] Azure env vars not configured — returning fallback.");
    return {
      success: false,
      error: "Azure environment variables are not fully configured on this server.",
      verificationId: "AZURE_NOT_CONFIGURED",
      fqdn: "app.bolify.ai",
    };
  }

  try {
    console.log("[AzureContainerService] Cache miss — fetching from Azure ARM API (one-time only)...");
    const acaClient = getArmClient();

    // Fetch with 15s hard timeout
    const [app, env] = await Promise.all([
      (acaClient.containerApps.get(resourceGroupName, containerAppName, {
        abortSignal: AbortSignal.timeout(15000),
      }) as Promise<any>),
      (acaClient.managedEnvironments.get(resourceGroupName, environmentName, {
        abortSignal: AbortSignal.timeout(15000),
      }) as Promise<any>),
    ]);

    const fqdn = app.configuration?.ingress?.fqdn || "app.bolify.ai";
    const verificationId =
      env.customDomainConfiguration?.customDomainVerificationId ||
      "pending-verification-id";

    // Store in memory — never call ARM again for this info
    _cachedDetails = { verificationId, fqdn };
    console.log("[AzureContainerService] ARM fetch successful. Cached for future requests.");
    console.log(`[AzureContainerService]   → verificationId: ${verificationId}`);
    console.log(`[AzureContainerService]   → fqdn: ${fqdn}`);
    console.log("[AzureContainerService] TIP: Set AZURE_DOMAIN_VERIFICATION_ID and AZURE_APP_FQDN in .env to skip this call on next deploy.");

    return { success: true, verificationId, fqdn };
  } catch (error: any) {
    console.error("[AzureContainerService] ARM fetch failed:", error.message || error);
    return {
      success: false,
      error: `Azure Configuration Error: ${error.message || "Unknown error"}`,
      verificationId: "AZURE_NOT_CONFIGURED",
      fqdn: "app.bolify.ai",
    };
  }
}

/**
 * Validates and binds a custom domain to the Azure Container App.
 * Requires the user to have already added:
 *   - TXT record: `asuid.<domain>` → Container App's Custom Domain Verification ID
 *   - CNAME record: `<domain>` → Container App's FQDN
 */
export async function bindCustomDomain(domain: string) {
  const acaClient = getArmClient();

  console.log(`[AzureContainerService] Starting domain binding for: ${domain}`);

  // 1. Get current Container App configuration
  const app = await acaClient.containerApps.get(resourceGroupName, containerAppName);
  if (!app?.configuration?.ingress) {
    throw new Error("Container App or Ingress configuration not found");
  }

  // Azure ARM requires we do NOT send scrubbed secrets back on PUT/PATCH
  if (app.configuration.secrets) {
    delete app.configuration.secrets;
  }

  const existingDomains = app.configuration.ingress.customDomains || [];
  const existingDomain = existingDomains.find((d: any) => d.name === domain);

  // Check if already fully bound
  if (existingDomain?.bindingType === "SniEnabled" && existingDomain?.certificateId) {
    console.log(`[AzureContainerService] Domain ${domain} is already fully bound with SSL.`);
    return { success: true, message: "Domain already bound with SSL" };
  }

  // 2. Bind domain WITHOUT SSL first to validate DNS (TXT/CNAME)
  if (!existingDomain) {
    console.log(`[AzureContainerService] Validating DNS and binding ${domain} (Disabled binding)...`);
    existingDomains.push({ name: domain, bindingType: "Disabled" });

    try {
      await acaClient.containerApps.beginUpdateAndWait(resourceGroupName, containerAppName, app);
      console.log(`[AzureContainerService] DNS validation successful for ${domain}`);
    } catch (err: any) {
      console.error("[AzureContainerService] DNS Validation failed:", err.message);
      throw new Error(
        err.message || "Domain DNS validation failed. Ensure TXT and CNAME records are correct."
      );
    }
  }

  // 3. Provision SSL in background (takes 5-15 minutes — do not await)
  provisionSslInBackground(domain, app.location!, resourceGroupName, environmentName, containerAppName);

  return {
    success: true,
    message:
      "Domain verified! SSL certificate is provisioning in the background (may take 5-15 minutes to secure).",
    fqdn: app.configuration?.ingress?.fqdn,
  };
}

async function provisionSslInBackground(
  domain: string,
  location: string,
  rg: string,
  envName: string,
  appName: string
) {
  try {
    const acaClient = getArmClient();
    const certName = `cert-${domain.replace(/\./g, "-")}`;
    console.log(`[AzureContainerService] [Background] Provisioning Certificate: ${certName}`);

    const certResult = await acaClient.managedCertificates.beginCreateOrUpdateAndWait(
      rg,
      envName,
      certName,
      {
        managedCertificateEnvelope: {
          location,
          properties: {
            domainControlValidation: "CNAME",
            subjectName: domain,
          },
        },
      }
    );

    const certId = (certResult as any).id;
    if (!certId) throw new Error("Failed to retrieve the created certificate ID.");
    console.log(`[AzureContainerService] [Background] Certificate created: ${certId}`);

    // Refresh app state and attach SSL
    console.log(`[AzureContainerService] [Background] Updating Container App Ingress with SSL...`);
    const appRefresh = await acaClient.containerApps.get(rg, appName);
    if (appRefresh.configuration?.secrets) {
      delete appRefresh.configuration.secrets;
    }

    const domainsRefresh = appRefresh.configuration?.ingress?.customDomains || [];
    const domainEntry = domainsRefresh.find((d: any) => d.name === domain);

    if (domainEntry) {
      domainEntry.bindingType = "SniEnabled";
      domainEntry.certificateId = certId;
      await acaClient.containerApps.beginUpdateAndWait(rg, appName, appRefresh);
      console.log(`[AzureContainerService] [Background] Successfully secured ${domain} with SSL!`);
    }
  } catch (err: any) {
    console.error(
      `[AzureContainerService] [Background] SSL provisioning failed for ${domain}:`,
      err.message || err
    );
  }
}
