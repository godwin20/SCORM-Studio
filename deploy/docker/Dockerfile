# Plain Docker option (not needed for TrueNAS, which uses deploy/truenas/truenas-app.yaml).
# Build from the project root after `npm run build`:
#   docker build -f deploy/docker/Dockerfile -t scorm-studio .
FROM node:22-alpine
WORKDIR /app
COPY server/server.js dist/scorm-studio.html ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:${PORT:-8787}/ping || exit 1
CMD ["node", "server.js"]
