#!/bin/bash
set -e

# Prompt user for Azure Login if not already logged in
if ! az account show > /dev/null 2>&1; then
    echo "Please log in to your Azure account..."
    az login
fi

echo "======================================================"
echo "    Deploying Deno Backend to Azure Container Apps"
echo "======================================================"

RESOURCE_GROUP="bolifyai-rg"
LOCATION="eastus"
REGISTRY_NAME="bolifyairegistry${RANDOM}"
ENV_NAME="bolifyai-env"
APP_NAME="bolifyai-api"

# Ask for the PostgreSQL connection string
echo ""
echo "Enter your Azure PostgreSQL Connection String"
echo "Example: postgresql://user:pass@server.postgres.database.azure.com:5432/bolifyai?sslmode=require"
read -p "Connection String: " DB_URL

echo ""
echo "Enter your Smartflo API Key:"
read -p "Smartflo Key: " SMARTFLO_KEY

echo ""
echo "Enter your Azure OpenAI Key:"
read -p "Azure OpenAI Key: " AZURE_OPENAI_KEY

echo ""
echo "Enter your Azure OpenAI Endpoint (e.g., https://your-resource.openai.azure.com/):"
read -p "Azure OpenAI Endpoint: " AZURE_OPENAI_ENDPOINT

echo ""
echo "Enter your Azure OpenAI Deployment Name (e.g., gpt-4o):"
read -p "Azure OpenAI Deployment Name: " AZURE_OPENAI_DEPLOYMENT

echo ""
echo "Creating Resource Group ($RESOURCE_GROUP)..."
az group create --name $RESOURCE_GROUP --location $LOCATION

echo ""
echo "Creating Container Registry ($REGISTRY_NAME)..."
az acr create --resource-group $RESOURCE_GROUP --name $REGISTRY_NAME --sku Basic --admin-enabled true

echo ""
echo "Building and pushing Deno Docker image to ACR..."
az acr build --registry $REGISTRY_NAME --image backend:latest .

echo ""
echo "Creating Azure Container Apps Environment ($ENV_NAME)..."
az containerapp env create \
  --name $ENV_NAME \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION

echo ""
echo "Deploying Container App ($APP_NAME)..."
az containerapp create \
  --name $APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --environment $ENV_NAME \
  --image $REGISTRY_NAME.azurecr.io/backend:latest \
  --target-port 8000 \
  --ingress 'external' \
  --registry-server $REGISTRY_NAME.azurecr.io \
  --env-vars "DATABASE_URL=$DB_URL" "JWT_SECRET=super_secret_bolifyai_key_production" "SMARTFLO_API_KEY=$SMARTFLO_KEY" "AZURE_OPENAI_KEY=$AZURE_OPENAI_KEY" "AZURE_OPENAI_ENDPOINT=$AZURE_OPENAI_ENDPOINT" "AZURE_OPENAI_DEPLOYMENT=$AZURE_OPENAI_DEPLOYMENT"

echo ""
echo "======================================================"
echo "Deployment Complete!"
echo "Check the Azure Portal to find your public URL for the Container App."
echo "======================================================"
