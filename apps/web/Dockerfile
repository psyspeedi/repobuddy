# syntax=docker/dockerfile:1.7
# Build context is the monorepo root.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# --- deps cache layer ---
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @repobuddy/web... --filter @repobuddy/shared

# --- sources + build ---
COPY packages/shared packages/shared/
COPY apps/web apps/web/
WORKDIR /repo/apps/web
RUN pnpm build

# --- runner ---
FROM node:22-bookworm-slim AS runner-web
WORKDIR /repo/apps/web
ENV NODE_ENV=production
ENV NUXT_HOST=0.0.0.0
ENV NUXT_PORT=3000
COPY --from=base /repo/apps/web/.output ./.output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
