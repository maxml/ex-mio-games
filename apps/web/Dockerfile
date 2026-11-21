# syntax=docker/dockerfile:1.7
# Build with: docker build -f apps/web/Dockerfile -t ex-mio-web .
# (build context must be the repo root)
# Requires `output: 'standalone'` in apps/web/next.config.mjs.
#
# The image is DOMAIN-AGNOSTIC. No `--build-arg` is needed — the browser talks to
# the API on the SAME ORIGIN (relative `/api`, `/healthz`, routed to the API by
# the single-host edge proxy), and the SSR base is read at runtime from the
# `API_URL` env. So ONE image promotes dev -> prod with no rebuild. Pass
# `--build-arg NEXT_PUBLIC_API_URL=https://api.example.com` ONLY to bake an
# absolute browser API URL (e.g. a `single_host: false` / cross-origin setup).

FROM node:24-alpine AS builder
RUN corepack enable && apk add --no-cache openssl
WORKDIR /repo
COPY . .
# Install only the web app and what it depends on, not the whole workspace.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@ex-mio/web..."
# Build the app's workspace deps by dependency graph: "@ex-mio/web^..." is "the deps of
# web, not web itself". Naming packages by hand goes stale the moment the app
# imports a new workspace package; the graph form cannot. (The UI package ships
# source and has no build step; Next compiles it via transpilePackages.)
RUN pnpm --filter "@ex-mio/web^..." build

# NEXT_PUBLIC_API_URL is an OPTIONAL build-time fallback, not a requirement.
# Left empty (the default), the client resolver falls back to the
# same origin (`resolveApiBaseUrl` in shared/config/runtime.ts) — nothing is
# baked, so the image is domain-agnostic. A non-empty value bakes an absolute
# browser API URL for cross-origin deployments. .env files are kept out of the
# build context (see .dockerignore), so this is never picked up implicitly.
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm --filter @ex-mio/web build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Next standalone binds to $HOSTNAME. Docker sets HOSTNAME to the container id,
# so without this the server listens only on that one interface and a loopback
# probe (the HEALTHCHECK below, and the Deckhand blue-green cutover check, both
# hit 127.0.0.1) is refused. Bind every interface instead.
ENV HOSTNAME=0.0.0.0
# Run as an unprivileged user. The app bundle stays root-owned and readable; the
# runtime user only owns Next's incremental cache, which the server writes to.
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public
RUN mkdir -p /app/apps/web/.next/cache && chown -R app:app /app/apps/web/.next/cache
WORKDIR /app/apps/web
USER app:app
EXPOSE 3000
# Container-level liveness for autoheal and `docker compose up --wait`. /health
# is a dependency-free 200 web route (app/health/route.ts); Node 24 ships a
# global fetch. Deckhand gates blue-green cutover on this same route separately.
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
