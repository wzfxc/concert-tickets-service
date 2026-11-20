# Multi-stage image for node apps: api | worker | mailstub | migrate
FROM node:22-slim AS base
ENV CI=true
# openssl must exist BEFORE pnpm install so Prisma downloads the matching (3.0.x) engines
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG APP
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@tickets/shared" build && pnpm --filter "@tickets/${APP}..." build
RUN pnpm --filter "@tickets/${APP}" --prod deploy --legacy /out \
 && cp -r apps/${APP}/dist /out/dist \
 && if [ -d apps/${APP}/migrations ]; then cp -r apps/${APP}/migrations /out/migrations; fi

FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Prisma engines need libssl (the slim image ships without it)
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
USER node
CMD ["node", "dist/main.js"]
