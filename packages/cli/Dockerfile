FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
RUN npm ci
COPY packages/core ./packages/core
COPY packages/cli ./packages/cli
RUN npm run build --workspace=packages/core && \
    npm run build --workspace=packages/cli

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
RUN npm ci --omit=dev
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/cli/dist ./packages/cli/dist
ENTRYPOINT ["node", "packages/cli/dist/cli.js"]
