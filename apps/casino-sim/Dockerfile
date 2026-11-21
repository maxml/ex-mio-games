# syntax=docker/dockerfile:1.7
# Build from the repo root:  docker build -f apps/casino-sim/Dockerfile -t ex-mio-casino-sim .
# The three NestJS services share this shape; only the package name differs.

FROM node:24-alpine AS builder
RUN corepack enable
WORKDIR /repo
COPY . .
# Install only this service and what it depends on, not the whole workspace.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@ex-mio/casino-sim..."
# Libraries first (by dependency graph, so a new workspace import cannot go stale), then the service.
RUN pnpm --filter "@ex-mio/casino-sim^..." build && pnpm --filter @ex-mio/casino-sim build
# Production-only node_modules with the built workspace packages copied in.
RUN pnpm --filter @ex-mio/casino-sim deploy --prod /out

FROM node:24-alpine AS runner
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4004
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/package.json ./package.json
COPY --from=builder /repo/apps/casino-sim/dist ./dist
USER app:app
EXPOSE 4004
# Liveness only: no dependency is consulted, so a database outage does not restart the container.
# Readiness (/healthz/ready) is what the deploy plane checks before routing traffic.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
