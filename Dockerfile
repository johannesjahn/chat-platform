FROM oven/bun:1.3.14

WORKDIR /app

# ffmpeg is a system dependency for video attachment processing
# (VideoProcessing.ts, issue #251) — sharp (used for images) bundles its own
# native libs, but there's no npm-distributed ffmpeg binary this repo shells
# out to via Bun.$, so it has to come from the base image's package manager.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Install first, from just the manifest + lockfile, so this layer is cached
# across rebuilds that only change application source.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY drizzle ./drizzle
COPY drizzle.config.ts ./
COPY scripts ./scripts
COPY src ./src

# Run as the non-root `bun` user the base image ships with, rather than root.
RUN chown -R bun:bun /app
USER bun

ENV PORT=3000
EXPOSE 3000

# Liveness only (see src/Health.ts) — readiness (DB/Redis reachability) is a
# separate concern for the orchestrator's own readiness probe, not this
# container-level check. Uses `bun` rather than curl/wget since neither is
# guaranteed present in the base image.
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "start"]
