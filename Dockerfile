# syntax=docker/dockerfile:1.7

# One image for the whole product: API, staff console, and storefront.
#
# The storefront is served from this process on purpose. Its session cookie has
# to be first-party, and a separate domain would make it third-party - which is
# the difference between a cookie that works and one the browser drops. So there
# is no nginx stage and no second service: the API is the origin, and the
# same-origin property that the auth design depends on is a property of the
# image rather than of the deployment around it.

# --- deps: the full install, used only to build -------------------------------
FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# pnpm is not bundled with node; installing it from the lockfile-pinned version
# keeps the image's package manager from drifting away from the one CI used.
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
# better-sqlite3 is a native module. prebuild-install usually finds a prebuilt
# binary, but not on every platform, so a compiler is kept here rather than
# gambling on it at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Manifests only, so this layer is cached until a dependency actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- build: compile everything ------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
# The API resolves the two client builds by walking up from its own dist
# directory, so the workspace layout has to be reproduced in the image.
RUN pnpm build \
    && test -f apps/api/dist/index.js \
    && test -f apps/web/dist/index.html

# --- prod-deps: the runtime install, without devDependencies ------------------
# A separate install rather than a prune of the build stage: pruning a pnpm
# workspace in place is easy to get subtly wrong, and shipping devDependencies
# to production is the kind of thing that should not be done on trust.
FROM node:22-bookworm-slim AS prod-deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# --- runtime: what actually ships ---------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH \
    API_PORT=4000 API_HOST=0.0.0.0 LOG_LEVEL=info \
    DATABASE_PATH=/data/refund.sqlite \
    WEB_STATIC_DIR=/app/apps/web/dist
WORKDIR /app

# tini reaps zombies and forwards signals, so `docker stop` reaches Node and the
# container can be shut down without the 10-second SIGKILL wait.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Policy and audit source, so a reviewer can read the rules that produced a
# decision without checking out the repository the container was built from.
COPY REFUND_POLICY.md ./

# The SQLite file lives on a volume the API owns, and the API runs unprivileged.
# A named volume is created root-owned, so the directory is handed over here
# rather than at start-up, which would need root to do it.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
