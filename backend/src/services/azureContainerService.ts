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

    const makeTimeout = () => new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Azure Connection Timeout. Check service principal credentials.")), 15000)
    );

    // Get the Container App to find its default FQDN
    const app = await Promise.race([
      acaClient.containerApps.get(resourceGroupName, containerAppName),
      makeTimeout()
    ]) as any;
    const defaultFqdn = app.configuration?.ingress?.fqdn || "app.bolify.ai";

    // Get the Managed Environment to find the Custom Domain Verification ID
    const env = await Promise.race([
      acaClient.managedEnvironments.get(resourceGroupName, environmentName),
      makeTimeout()
    ]) as any;
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

  // Check if already bound
  const existingDomains = app.configuration.ingress.customDomains || [];
  if (existingDomains.find(d => d.name === domain)) {
    console.log(`[AzureContainerService] Domain ${domain} is already bound.`);
    return { success: true, message: "Domain already bound" };
  }

  // 2. Create a Managed Certificate for the environment
  const certName = `cert-${domain.replace(/\./g, "-")}`;
  console.log(`[AzureContainerService] Provisioning Managed Environment Certificate: ${certName}`);
  
  // Create Managed Certificate
  // Using beginCreateOrUpdateAndWait to wait for the certificate provisioning
  const certPoller = await acaClient.managedCertificates.beginCreateOrUpdateAndWait(
    resourceGroupName,
    environmentName,
    certName,
    {
      managedCertificateEnvelope: {
        location: app.location,
        properties: {
          domainControlValidation: "CNAME",
          subjectName: domain
        }
      }
    }
  );
  
  const certId = certPoller.id;
  if (!certId) {
    throw new Error("Failed to retrieve the created certificate ID.");
  }
  console.log(`[AzureContainerService] Certificate created with ID: ${certId}`);

  // 3. Update the Container App Ingress with the new Custom Domain and bound Certificate
  console.log(`[AzureContainerService] Updating Container App Ingress to bind domain...`);
  
  existingDomains.push({
    name: domain,
    bindingType: "SniEnabled",
    certificateId: certId
  });

  const timeout = new Promise<never>((_, reject) => 
    setTimeout(() => reject(new Error("Azure Connection Timeout. Update took too long.")), 30000)
  );

  const updatePoller = await Promise.race([acaClient.containerApps.beginUpdateAndWait(
    resourceGroupName,
    containerAppName,
    {
      ...app,
      configuration: {
        ...app.configuration,
        ingress: {
          ...app.configuration.ingress,
          customDomains: existingDomains
        }
      }
    }
  ), timeout]);

  console.log(`[AzureContainerService] Successfully bound ${domain} to the Container App.`);
  
  return { 
    success: true, 
    message: "Domain verified and bound successfully",
    fqdn: updatePoller.configuration?.ingress?.fqdn
  };
}
