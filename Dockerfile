FROM oven/bun:1.1.20-alpine AS base
WORKDIR /app

COPY package.json ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./
COPY config.json ./

EXPOSE 2332

CMD ["bun", "run", "src/index.ts"]
