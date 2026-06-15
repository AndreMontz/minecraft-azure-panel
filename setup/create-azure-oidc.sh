#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$#" -ne 2 ]]; then
  printf 'Uso: bash create-azure-oidc.sh USUARIO_GITHUB REPOSITORIO\n' >&2
  exit 2
fi

readonly GITHUB_OWNER="$1"
readonly GITHUB_REPO="$2"
readonly RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-andremontz-contato_group}"
readonly VM_NAME="${AZURE_VM_NAME:-Mine-Etec}"
readonly APP_NAME="github-${GITHUB_OWNER}-${GITHUB_REPO}-minecraft"
readonly CREDENTIAL_NAME="github-main"

subscription_id="$(az account show --query id --output tsv)"
tenant_id="$(az account show --query tenantId --output tsv)"
vm_id="$(az vm show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${VM_NAME}" \
  --query id \
  --output tsv)"

app_object_id="$(az ad app list \
  --display-name "${APP_NAME}" \
  --query '[0].id' \
  --output tsv)"
if [[ -z "${app_object_id}" ]]; then
  app_object_id="$(az ad app create \
    --display-name "${APP_NAME}" \
    --query id \
    --output tsv)"
fi

client_id="$(az ad app show \
  --id "${app_object_id}" \
  --query appId \
  --output tsv)"
service_principal_id="$(az ad sp list \
  --filter "appId eq '${client_id}'" \
  --query '[0].id' \
  --output tsv)"
if [[ -z "${service_principal_id}" ]]; then
  service_principal_id="$(az ad sp create \
    --id "${client_id}" \
    --query id \
    --output tsv)"
fi

az role assignment create \
  --assignee-object-id "${service_principal_id}" \
  --assignee-principal-type ServicePrincipal \
  --role "Virtual Machine Contributor" \
  --scope "${vm_id}" \
  --output none

existing_credential="$(az ad app federated-credential list \
  --id "${app_object_id}" \
  --query "[?name=='${CREDENTIAL_NAME}'].id | [0]" \
  --output tsv)"
if [[ -z "${existing_credential}" ]]; then
  credential_file="$(mktemp)"
  trap 'rm -f "${credential_file:-}"' EXIT
  cat > "${credential_file}" <<EOF
{
  "name": "${CREDENTIAL_NAME}",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:${GITHUB_OWNER}/${GITHUB_REPO}:ref:refs/heads/main",
  "description": "Controle da VM Mine-Etec pelo GitHub Actions",
  "audiences": ["api://AzureADTokenExchange"]
}
EOF
  az ad app federated-credential create \
    --id "${app_object_id}" \
    --parameters @"${credential_file}" \
    --output none
fi

cat <<EOF

Conexao Azure OIDC criada com acesso limitado a:
${vm_id}

Cadastre estes GitHub Actions secrets:
AZURE_CLIENT_ID=${client_id}
AZURE_TENANT_ID=${tenant_id}
AZURE_SUBSCRIPTION_ID=${subscription_id}

Cadastre estas GitHub Actions variables:
AZURE_RESOURCE_GROUP=${RESOURCE_GROUP}
AZURE_VM_NAME=${VM_NAME}
EOF
