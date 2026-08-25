# Kurum içi arayüz — vinext standalone Node çıktısı.
# API bu imajda sunulmaz; nginx /api yollarını ayrı `api` servisine yöneltir.

FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ENV NODE_ENV=production
RUN npm run build:onprem-ui

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /app/dist/standalone ./
COPY --chown=node:node server/ui-healthcheck.mjs ./ui-healthcheck.mjs

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "ui-healthcheck.mjs"]

CMD ["node", "server.js"]
