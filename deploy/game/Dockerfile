FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

# Only the server: one bundled file and the map data. No node_modules, no client code.
FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 WILDSTATE_DATA_DIR=/data DSM_GAME_RECORD=/data/dsm-game.json DSM_APP_HOST=http://127.0.0.1:8787 DSM_APP_HOST_SECRET_FILE=/ingress/ingress-token
WORKDIR /app
RUN addgroup -g 10001 -S wildstate && adduser -u 10001 -S -G wildstate -h /data -s /sbin/nologin wildstate
COPY --from=build /app/dist/backend/server.mjs ./server.mjs
COPY src/tiled ./src/tiled
USER 10001:10001
CMD ["node", "server.mjs"]
