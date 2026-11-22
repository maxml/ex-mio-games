# syntax=docker/dockerfile:1.7
# Build from the repo root:  docker build -f apps/engagement/Dockerfile -t ex-mio-engagement .
# The three NestJS services share this shape; only the package name differs.

FROM node:24-alpine AS builder
RUN corepack enable
WORKDIR /repo
COPY . .
# These steps are identical in every service Dockerfile, so BuildKit builds them once and reuses
# the layers for the other images (one install, one compile of the shared packages).
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@ex-mio/identity..." --filter "@ex-mio/engagement..." --filter "@ex-mio/payments..." --filter "@ex-mio/casino-sim..."
RUN pnpm --filter "./packages/*" build
# Then only this service.
RUN pnpm --filter @ex-mio/engagement build
# Fail the build, not the deploy, when the compiled migrations are missing (migrate.js refuses to run with none too).
RUN test -n "$(ls apps/engagement/dist/model/migrations/*.js 2>/dev/null)" && test -f apps/engagement/dist/migrate.js
# Production-only node_modules with the built workspace packages copied in.
RUN pnpm --filter @ex-mio/engagement deploy --prod /out

FROM node:24-alpine AS runner
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4002
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/package.json ./package.json
COPY --from=builder /repo/apps/engagement/dist ./dist
USER app:app
EXPOSE 4002
# Liveness only: no dependency is consulted, so a database outage does not restart the container.
# Readiness (/healthz/ready) is what the deploy plane checks before routing traffic.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations are a separate one-off step:  node dist/migrate.js   (exit 0 = applied, 1 = failed)
CMD ["node", "dist/main.js"]
