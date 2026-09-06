# Χημεία Quiz — static PWA. No build step, no dependencies.
FROM nginx:1.27-alpine

LABEL org.opencontainers.image.title="Chemistry-app" \
      org.opencontainers.image.description="Phone-first PWA for drilling Greek chemistry textbook questions." \
      org.opencontainers.image.source="https://github.com/GiorgosPap777/Chemistry-app"

COPY nginx.conf /etc/nginx/conf.d/default.conf

WORKDIR /usr/share/nginx/html
COPY index.html styles.css app.js questions.json manifest.webmanifest sw.js ./
COPY icons/ ./icons/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
