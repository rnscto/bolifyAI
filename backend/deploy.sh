#!/bin/bash
set -e

# Load .env file properly
set -o allexport
source .env
set +o allexport

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

DB_URL=$DATABASE_URL

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
  --env-vars "DATABASE_URL=$DB_URL" "JWT_SECRET=super_secret_bolifyai_key_production" "SMARTFLO_API_KEY=$SMARTFLO_API_KEY" "AZURE_OPENAI_KEY=$AZURE_OPENAI_KEY" "AZURE_OPENAI_ENDPOINT=$AZURE_OPENAI_ENDPOINT" "AZURE_OPENAI_DEPLOYMENT=$AZURE_OPENAI_DEPLOYMENT"

echo ""
echo "======================================================"
echo "Deployment Complete!"
echo "Check the Azure Portal to find your public URL for the Container App."
echo "======================================================"
