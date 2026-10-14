FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 2222
CMD ["node", "src/index.js"]
