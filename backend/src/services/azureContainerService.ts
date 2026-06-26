import { ContainerAppsAPIClient } from "npm:@azure/arm-appcontainers";
import { DefaultAzureCredential } from "npm:@azure/identity";

const subscriptionId = Deno.env.get("AZURE_SUBSCRIPTION_ID") || process.env.AZURE_SUBSCRIPTION_ID || "";
const resourceGroupName = Deno.env.get("AZURE_RESOURCE_GROUP") || process.env.AZURE_RESOURCE_GROUP || "";
const containerAppName = Deno.env.get("AZURE_CONTAINER_APP_NAME") || process.env.AZURE_CONTAINER_APP_NAME || "";
const environmentName = Deno.env.get("AZURE_CONTAINER_ENV_NAME") || process.env.AZURE_CONTAINER_ENV_NAME || "";

let client: ContainerAppsAPIClient | null = null;

function getClient() {
  if (!client) {
    if (!subscriptionId) {
      throw new Error("Azure Subscription ID is not configured");
    }
    const credential = new DefaultAzureCredential();
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
  try {
    const acaClient = getClient();
    
    // Add a 15-second timeout to prevent 504 Gateway Timeout from load balancers
    const timeout = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error("Azure Connection Timeout. Please check your service principal credentials.")), 15000)
    );

    // Get the Container App to find its default FQDN
    const appPromise = acaClient.containerApps.get(resourceGroupName, containerAppName);
    const app = await Promise.race([appPromise, timeout]) as any;
    const defaultFqdn = app.configuration?.ingress?.fqdn || "app.bolify.ai";

    // Get the Managed Environment to find the Custom Domain Verification ID
    const envPromise = acaClient.managedEnvironments.get(resourceGroupName, environmentName);
    const env = await Promise.race([envPromise, timeout]) as any;
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
      // Fallback details to allow UI to render even if Azure is misconfigured locally
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
