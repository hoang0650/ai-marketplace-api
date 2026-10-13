# syntax=docker/dockerfile:1
# Production image for ai-marketplace-api (Dokploy: Build Type = Dockerfile, port 4100).
# Pure-JS dependencies only (bcryptjs, no sharp/bcrypt), so Alpine (musl) is fine. No build step.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4100
WORKDIR /app
# The official image ships a non-root "node" user (uid 1000).
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
USER node
EXPOSE 4100
# Liveness: GET /health (no DB needed). /health/ready also checks MongoDB.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Same as `npm start`, without npm in front so signals reach node.
CMD ["node", "src/server.js"]
