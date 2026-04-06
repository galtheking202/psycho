#!/bin/sh
set -e

# Replace the placeholder with the actual BACKEND_URL at container start time
BACKEND_URL="${BACKEND_URL:-http://backend:8000}"
sed "s|BACKEND_URL_PLACEHOLDER|${BACKEND_URL}|g" \
    /etc/nginx/conf.d/default.conf.template \
    > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
