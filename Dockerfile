# Build the Lettio MCP server and run it over stdio.
# Introspection (tools/list) works without credentials; mailbox access is
# configured at runtime via LETTIO_USERNAME / LETTIO_PASSWORD (or LETTIO_ACCOUNTS).

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ENTRYPOINT ["node", "dist/index.js"]
