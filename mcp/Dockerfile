# syntax=docker/dockerfile:1

# Pinned to a minor rather than the floating `22-slim`: the npm package this
# image wraps is published with exact-version lock-step, and an image that
# silently changes its runtime underneath a pinned application defeats that.
ARG NODE_VERSION=22.23-slim

# ── build ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Version is stamped at build time by the publish workflow, which has already
# rewritten package.json to mirror the SDK release it wraps.
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="triex-mcp" \
      org.opencontainers.image.description="Keyless, multi-tenant MCP server for Trinary Exchange" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/loash-industries/sdk"

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist

# The server holds no key material and no credential store; it still runs
# unprivileged, and the image ships no shell-accessible secrets.
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
