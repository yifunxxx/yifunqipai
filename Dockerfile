# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --filter @yifun/qipai-server... --filter @yifun/qipai-shared...
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm --filter @yifun/qipai-shared build && pnpm --filter @yifun/qipai-server build

FROM node:22-bookworm-slim AS runner
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate \
  && groupadd -r qipai && useradd -r -g qipai -d /app qipai
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --filter @yifun/qipai-server... --filter @yifun/qipai-shared... --prod
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
RUN mkdir -p /data && chown -R qipai:qipai /app /data
USER qipai
ENV PORT=8787
ENV DATA_DIR=/data
ENV SESSION_TTL_MS=86400000
ENV NODE_OPTIONS=--experimental-sqlite
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-sqlite", "packages/server/dist/index.js"]
