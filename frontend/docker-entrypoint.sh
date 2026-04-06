#!/bin/sh
set -e

# Strip any trailing slash from BACKEND_URL
BACKEND_URL="${BACKEND_URL:-http://backend:8000}"
BACKEND_URL="${BACKEND_URL%/}"

echo "[entrypoint] BACKEND_URL=${BACKEND_URL}"

sed "s|BACKEND_URL_PLACEHOLDER|${BACKEND_URL}|g" \
    /etc/nginx/conf.d/default.conf.template \
    > /etc/nginx/conf.d/default.conf

echo "[entrypoint] Generated nginx config:"
cat /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
