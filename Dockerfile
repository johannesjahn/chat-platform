FROM oven/bun:1

WORKDIR /app

# Install first, from just the manifest + lockfile, so this layer is cached
# across rebuilds that only change application source.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY drizzle ./drizzle
COPY drizzle.config.ts ./
COPY src ./src

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "start"]
