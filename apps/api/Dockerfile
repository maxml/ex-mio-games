# syntax=docker/dockerfile:1.7
# Build with: docker build -f apps/api/Dockerfile -t ex-mio-api .
# (build context must be the repo root)

FROM node:24-alpine AS builder
RUN corepack enable && apk add --no-cache openssl
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# Build the app's workspace deps by dependency graph: "api^..." is "the deps of
# api, not api itself" (shared-types + auth today). Naming packages by hand goes
# stale the moment the app imports a new workspace package; the graph form cannot.
RUN pnpm --filter "api^..." build
RUN pnpm --filter api build
# Pruned production deployment: prod-only node_modules with the workspace deps
# (shared-types, auth) injected, no devDependencies and no repo source. `dist`
# is gitignored, so pnpm deploy omits it; it is copied explicitly below.
RUN pnpm --filter api deploy --prod /out

FROM node:24-alpine AS runner
RUN apk add --no-cache openssl
# Run as an unprivileged user. The app bundle stays root-owned and read-only: the
# API writes nothing under /app at runtime (uploads go to a mounted storage
# volume, logs to stdout), so a compromised process cannot rewrite its own code.
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
# Only the built JS plus the pruned production node_modules — no source, no
# devDependencies, no other workspaces.
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/package.json ./package.json
COPY --from=builder /repo/apps/api/dist ./dist
USER app:app
EXPOSE 4000
# Container-level liveness for autoheal and `docker compose up --wait`.
# /healthz/live returns 200 whenever the process is up (no dependencies), so
# autoheal restarts only a dead process, not a transient DB outage. Deckhand
# gates blue-green cutover on /healthz/ready separately (see .deckhand/deploy.yml).
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
