# What `pnpm dev` runs (deploy/dev/stack.sh): the Node image and dependencies
# a host runs, on Linux, with each package's built code mounted from the
# worktree. Node restarts when it changes, and this is built again only when
# the dependencies do.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/core/package.json apps/core/package.json
COPY apps/manager/package.json apps/manager/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
# The app SDK's command shim, which pnpm links when it installs.
COPY packages/app-sdk/bin packages/app-sdk/bin
COPY packages/app-testkit/package.json packages/app-testkit/package.json
COPY packages/auth-protocol/package.json packages/auth-protocol/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
COPY packages/ui-sdk/package.json packages/ui-sdk/package.json
# The catalog apps, one line each, as in apps/core/Dockerfile.
COPY catalog/apps/moods/package.json catalog/apps/moods/package.json
COPY catalog/apps/natural-light/package.json catalog/apps/natural-light/package.json
COPY catalog/apps/weather/package.json catalog/apps/weather/package.json
COPY catalog/apps/zigbee/package.json catalog/apps/zigbee/package.json
RUN pnpm install --filter @meetsanctum/core... --filter @meetsanctum/manager... --filter "{./catalog/apps/**}..." --frozen-lockfile

FROM deps AS core
ARG SANCTUM_VERSION=dev-stack
ENV NODE_ENV=production \
    SANCTUM_VERSION=$SANCTUM_VERSION \
    CORE_HOST=0.0.0.0 \
    CORE_PORT=4100 \
    CORE_DATA_DIR=/data \
    CORE_SYSTEM_APPS_DIR=/app/deploy/dev/apps \
    CORE_OFFICIAL_APPS_DIR=/app/catalog/apps \
    CORE_MANAGER_SOCKET=/run/sanctum/manager.sock
LABEL sanctum.service="core" \
      org.opencontainers.image.title="sanctum-core" \
      org.opencontainers.image.version=$SANCTUM_VERSION
# The fake lights in deploy/dev/apps find the app SDK from here, as a catalog
# app finds it in its own node_modules.
RUN mkdir -p /app/node_modules/@meetsanctum && ln -s /app/packages/app-sdk /app/node_modules/@meetsanctum/app-sdk
WORKDIR /app/apps/core
EXPOSE 4100
CMD ["node", "--watch", "--watch-preserve-output", "dist/index.js"]

FROM deps AS manager
ARG SANCTUM_VERSION=dev-stack
ENV NODE_ENV=production \
    SANCTUM_VERSION=$SANCTUM_VERSION \
    MANAGER_SOCKET=/run/sanctum/manager.sock \
    MANAGER_DATA_DIR=/data \
    MANAGER_CORE_DATA_DIR=/core-data \
    MANAGER_SUPERVISE=true
LABEL sanctum.service="manager" \
      org.opencontainers.image.title="sanctum-manager" \
      org.opencontainers.image.version=$SANCTUM_VERSION
WORKDIR /app/apps/manager
# What checks, attaches and grows apps' images, as on a host.
RUN apk add --no-cache e2fsprogs e2fsprogs-extra losetup util-linux-misc
CMD ["node", "--watch", "--watch-preserve-output", "dist/index.js"]
