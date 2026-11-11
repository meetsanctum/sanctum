FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/core/package.json apps/core/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
# The app SDK's command shim, which pnpm links when it installs.
COPY packages/app-sdk/bin packages/app-sdk/bin
COPY packages/app-testkit/package.json packages/app-testkit/package.json
COPY packages/auth-protocol/package.json packages/auth-protocol/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
# Catalog apps' pages use it; the shell bundles them, so the image builds
# none of it.
COPY packages/ui-sdk/package.json packages/ui-sdk/package.json
# The catalog apps the image ships, one line each.
COPY catalog/apps/moods/package.json catalog/apps/moods/package.json
COPY catalog/apps/natural-light/package.json catalog/apps/natural-light/package.json
COPY catalog/apps/weather/package.json catalog/apps/weather/package.json
COPY catalog/apps/zigbee/package.json catalog/apps/zigbee/package.json
RUN pnpm install --filter @meetsanctum/core... --filter "{./catalog/apps/**}..." --frozen-lockfile

FROM deps AS build
COPY packages/typescript-config packages/typescript-config
COPY packages/app-sdk packages/app-sdk
COPY packages/app-testkit packages/app-testkit
COPY packages/auth-protocol packages/auth-protocol
COPY apps/core apps/core
COPY catalog/apps catalog/apps
RUN pnpm --filter @meetsanctum/core... --filter "{./catalog/apps/**}..." build
RUN pnpm --filter @meetsanctum/core deploy --prod --legacy /out
# Catalog apps are Sanctum's own, so the core gives them the official origin
# from the folder they ship in. Each stands alone, with its own production
# dependencies and its own copy of the app SDK, since the manager stages it
# apart from this image. pnpm's own record goes: it holds this build's time, and
# an app that hasn't changed must come out the same. So does its link from a
# package back to this stage's workspace, which is nothing once built and which
# Docker refuses to unpack.
RUN set -e; for app in catalog/apps/*/; do \
      out="/out/catalog/official/$(basename "$app")"; \
      pnpm --filter "./${app%/}" deploy --prod --legacy "$out"; \
      rm "$out/node_modules/.modules.yaml"; \
      find "$out" -type l | while read -r link; do \
        case "$(realpath "$link" 2>/dev/null)" in "$out"/*) ;; *) rm "$link" ;; esac; \
      done; \
    done

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime
ARG SANCTUM_VERSION=dev
ENV NODE_ENV=production \
    SANCTUM_VERSION=$SANCTUM_VERSION \
    CORE_HOST=0.0.0.0 \
    CORE_PORT=4100 \
    CORE_DATA_DIR=/data \
    CORE_SYSTEM_APPS_DIR=/app/catalog/system \
    CORE_OFFICIAL_APPS_DIR=/app/catalog/official \
    CORE_MANAGER_SOCKET=/run/sanctum/manager.sock
LABEL sanctum.service="core" \
      org.opencontainers.image.title="sanctum-core" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version=$SANCTUM_VERSION
WORKDIR /app
COPY --from=build /out ./
COPY LICENSE ./
EXPOSE 4100
CMD ["node", "dist/index.js"]
