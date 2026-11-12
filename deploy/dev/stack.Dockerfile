# What `pnpm dev` runs (deploy/dev/stack.sh): the Node image and dependencies
# a host runs, on Linux, with each package's built code mounted from the
# worktree. Node restarts when it changes, and this is built again only when
# the dependencies do. Apps run apart, as on a host: the manager stages each
# from its dependencies here and its code in the worktree.
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
COPY deploy/dev/apps/fake-lights/package.json deploy/dev/apps/fake-lights/package.json
RUN pnpm install --filter @meetsanctum/core... --filter @meetsanctum/manager... --filter "{./catalog/apps/**}..." --filter "{./deploy/dev/apps/**}..." --frozen-lockfile

# Each app's production dependencies on Linux, as apps/core/Dockerfile makes
# its packages, with none of its code: the manager stages that from the
# worktree's build (apps/manager/src/update/stack-packages.ts). pnpm's record
# and links out of the package go, as there.
FROM deps AS packages
RUN set -e; for app in catalog/apps/*/ deploy/dev/apps/*/; do \
      out="/app/stack-packages/$(basename "$app")"; \
      pnpm --filter "./${app%/}" deploy --prod --legacy "$out"; \
      rm "$out/node_modules/.modules.yaml"; \
      find "$out" -type l | while read -r link; do \
        case "$(realpath "$link" 2>/dev/null)" in "$out"/*) ;; *) rm "$link" ;; esac; \
      done; \
    done

FROM deps AS core
ARG SANCTUM_VERSION=dev-stack
ENV NODE_ENV=production \
    SANCTUM_VERSION=$SANCTUM_VERSION \
    CORE_HOST=0.0.0.0 \
    CORE_PORT=4100 \
    CORE_DATA_DIR=/data \
    CORE_MANAGER_SOCKET=/run/sanctum/manager.sock \
    CORE_OFFICIAL_APPS_DIR=/app/catalog/official \
    CORE_OFFICIAL_APPS_APART=sanctum.weather,sanctum.natural-light,sanctum.moods,sanctum.zigbee,sanctum.fake-lights
LABEL sanctum.service="core" \
      org.opencontainers.image.title="sanctum-core" \
      org.opencontainers.image.version=$SANCTUM_VERSION
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
COPY --from=packages /app/stack-packages /app/stack-packages
# What checks, attaches and grows apps' images, as on a host.
RUN apk add --no-cache e2fsprogs e2fsprogs-extra losetup util-linux-misc
CMD ["node", "--watch", "--watch-preserve-output", "dist/index.js"]
