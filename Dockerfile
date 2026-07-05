FROM oven/bun:1.3.14

WORKDIR /app

# Install first, from just the manifest + lockfile, so this layer is cached
# across rebuilds that only change application source.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY drizzle ./drizzle
COPY drizzle.config.ts ./
COPY src ./src

# Run as the non-root `bun` user the base image ships with, rather than root.
RUN chown -R bun:bun /app
USER bun

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "start"]
