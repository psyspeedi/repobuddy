# syntax=docker/dockerfile:1.7

# ---- base ----
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Native build tools for some optional deps (better-sqlite3, sharp). Keep slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

# ---- deps ----
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- builder ----
FROM deps AS builder
COPY . .
ENV NODE_ENV=production
RUN pnpm build && pnpm build:worker

# ---- runtime (production) ----
FROM node:22-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV NUXT_HOST=0.0.0.0
ENV NUXT_PORT=3000

# Nuxt server output (web)
COPY --from=builder /app/.output ./.output
# Worker bundle
COPY --from=builder /app/.worker ./.worker
# Drizzle migrations
COPY --from=builder /app/drizzle ./drizzle
# package.json for version metadata
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000

# Default entrypoint runs the web server. Override CMD in docker-compose for worker.
CMD ["node", ".output/server/index.mjs"]

# ---- dev (development with hot reload) ----
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 3000 24678
CMD ["pnpm", "dev"]
