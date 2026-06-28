import { ContainerAppsAPIClient } from "npm:@azure/arm-appcontainers";
import { ClientSecretCredential } from "npm:@azure/identity";

const subscriptionId = Deno.env.get("AZURE_SUBSCRIPTION_ID") ?? "";
const resourceGroupName = Deno.env.get("AZURE_RESOURCE_GROUP") ?? "";
const containerAppName = Deno.env.get("AZURE_CONTAINER_APP_NAME") ?? "";
const environmentName = Deno.env.get("AZURE_CONTAINER_ENV_NAME") ?? "";
const clientId = Deno.env.get("AZURE_CLIENT_ID") ?? "";
const clientSecret = Deno.env.get("AZURE_CLIENT_SECRET") ?? "";
const tenantId = Deno.env.get("AZURE_TENANT_ID") ?? "";

let client: ContainerAppsAPIClient | null = null;

function getClient() {
  if (!client) {
    if (!subscriptionId || !clientId || !clientSecret || !tenantId) {
      throw new Error("Azure credentials are not fully configured (need AZURE_SUBSCRIPTION_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID)");
    }
    // Use ClientSecretCredential directly instead of DefaultAzureCredential.
    // DefaultAzureCredential tries many auth providers in sequence (including Managed Identity
    // with a ~60s IMDS probe) even when service principal vars are set, causing the load
    // balancer to 503. ClientSecretCredential authenticates immediately and deterministically.
    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    client = new ContainerAppsAPIClient(credential, subscriptionId);
  }
  return client;
}

/**
 * Fetches the required Azure environment details for custom domain verification:
 * - The Custom Domain Verification ID (for the TXT record)
 * - The default FQDN of the Container App (for the CNAME record)
 */
export async function getAzureEnvironmentDetails() {
  // Short-circuit immediately if Azure env vars are not configured.
  if (!subscriptionId || !resourceGroupName || !containerAppName || !environmentName || !clientId || !clientSecret || !tenantId) {
    console.warn("[AzureContainerService] Azure env vars not configured — returning fallback.");
    return {
      success: false,
      error: "Azure environment variables are not fully configured on this server.",
      verificationId: "AZURE_NOT_CONFIGURED",
      fqdn: "app.bolify.ai"
    };
  }

  try {
    const acaClient = getClient();

    // Get the Container App to find its default FQDN
    const app = await acaClient.containerApps.get(resourceGroupName, containerAppName, { 
      abortSignal: AbortSignal.timeout(15000) 
    }) as any;
    const defaultFqdn = app.configuration?.ingress?.fqdn || "app.bolify.ai";

    // Get the Managed Environment to find the Custom Domain Verification ID
    const env = await acaClient.managedEnvironments.get(resourceGroupName, environmentName, { 
      abortSignal: AbortSignal.timeout(15000) 
    }) as any;
    const verificationId = env.customDomainConfiguration?.customDomainVerificationId || "pending-verification-id";

    return {
      success: true,
      verificationId,
      fqdn: defaultFqdn
    };
  } catch (error: any) {
    console.error("[AzureContainerService] Failed to get environment details:", error.message || error);
    return {
      success: false,
      error: `Azure Configuration Error: ${error.message || "Unknown error"}`,
      verificationId: "AZURE_NOT_CONFIGURED",
      fqdn: "app.bolify.ai"
    };
  }
}

/**
 * Validates and binds a custom domain to the Azure Container App.
 * This expects the user to have already added a TXT record `asuid.<domain>` 
 * with the Container App's Custom Domain Verification ID, and a CNAME record.
 */
export async function bindCustomDomain(domain: string) {
  const acaClient = getClient();
  
  console.log(`[AzureContainerService] Starting domain binding for: ${domain}`);
  
  // 1. Get current Container App configuration
  const app = await acaClient.containerApps.get(resourceGroupName, containerAppName);
  if (!app || !app.configuration || !app.configuration.ingress) {
    throw new Error("Container App or Ingress configuration not found");
  }

  // Azure ARM requires us to NOT send scrubbed secrets back on PUT/PATCH
  if (app.configuration.secrets) {
    delete app.configuration.secrets;
  }

  const existingDomains = app.configuration.ingress.customDomains || [];
  const existingDomain = existingDomains.find(d => d.name === domain);

  // Check if already fully bound
  if (existingDomain && existingDomain.bindingType === "SniEnabled" && existingDomain.certificateId) {
    console.log(`[AzureContainerService] Domain ${domain} is already fully bound with SSL.`);
    return { success: true, message: "Domain already bound with SSL" };
  }

  // 2. Bind domain to Container App WITHOUT SSL to synchronously validate DNS (TXT/CNAME)
  if (!existingDomain) {
    console.log(`[AzureContainerService] Validating DNS and binding ${domain} (Disabled binding)...`);
    existingDomains.push({
      name: domain,
      bindingType: "Disabled"
    });

    try {
      await acaClient.containerApps.beginUpdateAndWait(
        resourceGroupName,
        containerAppName,
        app
      );
      console.log(`[AzureContainerService] DNS validation successful for ${domain}`);
    } catch (err: any) {
      // If this throws, it's usually because the TXT record or CNAME is missing
      console.error("[AzureContainerService] DNS Validation failed:", err.message);
      throw new Error(err.message || "Domain DNS validation failed. Ensure TXT and CNAME records are correct.");
    }
  }

  // 3. Kick off Managed Certificate creation and SSL binding in the background
  // We do not await this because it can take 5-15 minutes, which causes frontend timeouts.
  provisionSslInBackground(domain, app.location!, resourceGroupName, environmentName, containerAppName);

  return { 
    success: true, 
    message: "Domain verified! SSL certificate is provisioning in the background (may take 5-15 minutes to secure).",
    fqdn: app.configuration?.ingress?.fqdn
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
    const acaClient = getClient();
    const certName = `cert-${domain.replace(/\./g, "-")}`;
    console.log(`[AzureContainerService] [Background] Provisioning Certificate: ${certName}`);
    
    const certPoller = await acaClient.managedCertificates.beginCreateOrUpdateAndWait(
      rg,
      envName,
      certName,
      {
        managedCertificateEnvelope: {
          location: location,
          properties: {
            domainControlValidation: "CNAME",
            subjectName: domain
          }
        }
      }
    );
    
    const certId = certPoller.id;
    if (!certId) throw new Error("Failed to retrieve the created certificate ID.");
    console.log(`[AzureContainerService] [Background] Certificate created: ${certId}`);

    // Refresh app state
    console.log(`[AzureContainerService] [Background] Updating Container App Ingress with SSL...`);
    const appRefresh = await acaClient.containerApps.get(rg, appName);
    if (appRefresh.configuration?.secrets) {
      delete appRefresh.configuration.secrets;
    }
    
    const domainsRefresh = appRefresh.configuration?.ingress?.customDomains || [];
    const domainEntry = domainsRefresh.find(d => d.name === domain);
    
    if (domainEntry) {
      domainEntry.bindingType = "SniEnabled";
      domainEntry.certificateId = certId;
      await acaClient.containerApps.beginUpdateAndWait(rg, appName, appRefresh);
      console.log(`[AzureContainerService] [Background] Successfully secured ${domain} with SSL!`);
    }
  } catch (err: any) {
    console.error(`[AzureContainerService] [Background] SSL provisioning failed for ${domain}:`, err.message || err);
  }
}
