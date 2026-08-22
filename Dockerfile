FROM docker.io/oven/bun:1.3.14-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun src ./src
COPY --chown=bun:bun config.example.ts tsconfig.json ./

ENV HOST=0.0.0.0
EXPOSE 2332
USER bun

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q -O - http://127.0.0.1:2332/proxy/health >/dev/null || exit 1

CMD ["bun", "run", "src/index.ts"]
