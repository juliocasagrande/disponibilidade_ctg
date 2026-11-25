#!/bin/sh
set -eu

: "${CALC_ID_WEB_PASSWORD:?Defina a senha de acesso ao painel nas variáveis do serviço.}"
: "${CALC_ID_ADMIN_PASSWORD:?Defina a senha de administrador nas variáveis do serviço.}"

if [ "${RAILWAY_VOLUME_MOUNT_PATH:-}" != /data ]; then
    echo 'Monte um volume persistente em /data.' >&2
    exit 1
fi

mkdir -p /data/dados /data/resultados
cp -rn /opt/calc-id/fontes/. dados/
python -m scripts.executar

exec python -m scripts.railway
