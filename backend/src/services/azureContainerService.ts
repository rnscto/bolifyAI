import { ContainerAppsAPIClient } from "@azure/arm-appcontainers";
import { DefaultAzureCredential } from "@azure/identity";

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
  const certPoller = await acaClient.managedEnvironmentCertificates.beginCreateOrUpdateAndWait(
    resourceGroupName,
    environmentName,
    certName,
    {
      properties: {
        domainControlValidation: "CNAME",
        subjectName: domain
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

  const updatePoller = await acaClient.containerApps.beginUpdateAndWait(
    resourceGroupName,
    containerAppName,
    {
      configuration: {
        ingress: {
          ...app.configuration.ingress,
          customDomains: existingDomains
        }
      }
    }
  );

  console.log(`[AzureContainerService] Successfully bound ${domain} to the Container App.`);
  
  return { 
    success: true, 
    message: "Domain verified and bound successfully",
    fqdn: updatePoller.configuration?.ingress?.fqdn
  };
}
