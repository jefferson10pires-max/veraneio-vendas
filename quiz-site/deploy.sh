#!/bin/bash
# Publica o site do quiz das clientes (veraneiosemijoias.web.app) no Firebase Hosting do projeto veraneio-vendas.
# Rodar no Cloud Shell do Google: bash deploy.sh
set -e
cd "$(dirname "$0")"
npx -y firebase-tools@13 hosting:sites:get veraneiosemijoias --project veraneio-vendas >/dev/null 2>&1 || npx -y firebase-tools@13 hosting:sites:create veraneiosemijoias --project veraneio-vendas
npx -y firebase-tools@13 deploy --only hosting --project veraneio-vendas
