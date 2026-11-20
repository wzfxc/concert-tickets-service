# Multi-stage image for node apps: api | worker | mailstub | migrate
FROM node:22-slim AS base
ENV CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG APP
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@tickets/shared" build && pnpm --filter "@tickets/${APP}" build
RUN pnpm --filter "@tickets/${APP}" --prod deploy --legacy /out \
 && cp -r apps/${APP}/dist /out/dist \
 && if [ -d apps/${APP}/migrations ]; then cp -r apps/${APP}/migrations /out/migrations; fi

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER node
CMD ["node", "dist/main.js"]
