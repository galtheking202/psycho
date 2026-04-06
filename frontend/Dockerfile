FROM nginx:alpine

# Copy static frontend files
COPY frontend/ /usr/share/nginx/html/

# Store nginx config as a template (processed at container start)
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf.template

# Copy and set up entrypoint that substitutes BACKEND_URL
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Remove default nginx config
RUN rm -f /etc/nginx/conf.d/default.conf

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
