# syntax=docker/dockerfile:1.7
# Build context is the monorepo root.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

# Native build tools needed by tree-sitter / postgres / sharp etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# --- deps cache layer: workspace manifests only ---
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @repobuddy/api... --filter @repobuddy/shared

# --- sources ---
COPY packages/shared packages/shared/
COPY apps/api apps/api/
COPY drizzle drizzle/

# --- runner-api ---
FROM base AS runner-api
ENV NODE_ENV=production
WORKDIR /repo/apps/api
EXPOSE 3001
# Run via tsx in production. nest build with swc is wired (apps/api/.swcrc,
# nest-cli.json, "build" script), but emits `#shared/*` and `#server/*`
# subpath aliases as relative paths against src/, which break after the
# move to dist/. tsc-alias or migrating to fully-relative imports across
# ~84 source files will unblock `node dist/src/main.js`. Until then tsx
# is the stable runtime.
CMD ["pnpm", "exec", "tsx", "src/main.ts"]

# --- runner-worker ---
FROM base AS runner-worker
ENV NODE_ENV=production
WORKDIR /repo/apps/api
CMD ["pnpm", "exec", "tsx", "src/main.worker.ts"]
