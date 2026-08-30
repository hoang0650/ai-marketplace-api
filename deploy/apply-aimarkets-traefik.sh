#!/usr/bin/env bash
# Chạy trên VPS (SSH root@72.62.72.165) sau khi paste aimarkets.yml vào Dokploy.
set -euo pipefail

DYNAMIC_DIR="${TRAEFIK_DYNAMIC_DIR:-/etc/dokploy/traefik/dynamic}"
AIMARKETS_FILE="${DYNAMIC_DIR}/aimarkets.yml"

echo "== Traefik dynamic dir =="
ls -la "${DYNAMIC_DIR}" 2>/dev/null || { echo "Không tìm thấy ${DYNAMIC_DIR}"; exit 1; }

if [[ ! -f "${AIMARKETS_FILE}" ]]; then
  echo "Thiếu ${AIMARKETS_FILE} — paste nội dung deploy/dokploy-dynamic-aimarkets.yml qua Dokploy UI trước."
  exit 1
fi

TRAEFIK_NAME="$(docker ps --format '{{.Names}}' | grep -i traefik | head -1 || true)"
if [[ -n "${TRAEFIK_NAME}" ]]; then
  echo "Reload Traefik container: ${TRAEFIK_NAME}"
  docker kill -s HUP "${TRAEFIK_NAME}" 2>/dev/null || docker restart "${TRAEFIK_NAME}"
else
  echo "Không thấy container Traefik đang chạy."
fi

echo "== Health =="
curl -fsS "https://api.aimarkets.vn/health" && echo
curl -fsS -o /dev/null -w "v1/products HTTP %{http_code}\n" "https://api.aimarkets.vn/v1/products?limit=1"
echo "Done."
