FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/manager/package.json apps/manager/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
RUN pnpm install --filter @meetsanctum/manager... --frozen-lockfile

FROM deps AS build
COPY packages/typescript-config packages/typescript-config
COPY apps/manager apps/manager
RUN pnpm --filter @meetsanctum/manager... build
RUN pnpm --filter @meetsanctum/manager deploy --prod --legacy /out

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime
ARG SANCTUM_VERSION=dev
# The manager runs on the host's network (deploy/compose.yml) to announce the
# host over mDNS. Its API listens only on a Unix socket, in a volume that only
# the core and the manager mount.
ENV NODE_ENV=production \
    SANCTUM_VERSION=$SANCTUM_VERSION \
    MANAGER_SOCKET=/run/sanctum/manager.sock \
    MANAGER_DATA_DIR=/data \
    MANAGER_CORE_DATA_DIR=/core-data \
    MANAGER_HOST_DEV_DIR=/host/dev \
    MANAGER_SUPERVISE=true \
    MANAGER_ANNOUNCE=true
LABEL sanctum.service="manager" \
      org.opencontainers.image.title="sanctum-manager" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version=$SANCTUM_VERSION
WORKDIR /app
COPY --from=build /out ./
COPY LICENSE ./
# What checks, attaches and grows apps' images (src/apps/images.ts).
RUN apk add --no-cache e2fsprogs e2fsprogs-extra losetup util-linux-misc
CMD ["node", "dist/index.js"]
