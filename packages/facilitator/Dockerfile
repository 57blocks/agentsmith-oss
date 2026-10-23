# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/facilitator/package.json ./packages/facilitator/package.json

FROM base AS prod-deps
RUN pnpm install --prod --frozen-lockfile

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY packages/facilitator/tsconfig.json ./packages/facilitator/tsconfig.json
COPY packages/facilitator/src ./packages/facilitator/src
RUN pnpm --filter @agentsmith/stellar-facilitator build

FROM node:24-alpine
ENV NODE_ENV=production PORT=8407 HOST=0.0.0.0
# The base image can lag Alpine security fixes; zlib 1.3.2-r1 fixes CVE-2026-85091.
RUN apk upgrade --no-cache zlib && mkdir -m 755 -p /app/certs
# CA for `sslmode=verify-full` to RDS: node-postgres verifies the server against it, and Node's
# default store does not hold the RDS roots. Pinned; an AWS bundle update fails the build.
ADD --chmod=0644 \
  --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
USER node
WORKDIR /app/packages/facilitator
COPY --from=prod-deps --chown=node:node /app/node_modules /app/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/facilitator/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/facilitator/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/facilitator/dist ./dist
EXPOSE 8407
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8407/health || exit 1
CMD ["node", "dist/src/main.js"]
