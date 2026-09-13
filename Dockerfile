# Build stage: full toolchain, then only what runs is copied forward.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# The slim images ship without OpenSSL, and Prisma probes for libssl at startup
# to pick its engine build. Without it every command prints a detection failure
# and falls back to a guess.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates   && rm -rf /var/lib/apt/lists/*

# `prisma generate` runs on install and needs the schema, so both land before
# it — as does the postinstall build script, which npm invokes by path. It
# finds no `src` at this point and skips, which is what we want: the layer
# above changes only when dependencies do.
COPY package*.json prisma.config.ts ./
COPY prisma ./prisma
COPY scripts/postinstall-build.mjs ./scripts/
RUN npm ci

COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# Drop everything a running process never imports. The Prisma CLI survives —
# it is a runtime dependency, because migrations run when the container starts.
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `prisma migrate deploy` runs here on every start, so the runtime needs OpenSSL
# too — not just the build stage.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates   && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json prisma.config.ts ./

# Never root, and never the implicit PID 1: node as PID 1 would have to handle
# reaping itself, and an unreaped child is how a container fills its table.
USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run migrations, then serve. `migrate deploy` is idempotent and applies only
# what is pending, so a restarted container is a no-op rather than a surprise.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
