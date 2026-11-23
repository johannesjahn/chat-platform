# CI and dependency updates

`workflows/ci.yml` runs on pushes to `main` and on PRs. The job list is in
the file; what it doesn't say:

- **Path filters** (issue #492): on PRs a leading `changes` job
  (`dorny/paths-filter`) decides which jobs the diff can affect; each job
  `needs: changes` and skips unless its filter matched. Pushes to `main` run
  everything, since `tag-release.yml` releases off that run. Every filter
  also matches `.github/workflows/**` and `.github/actions/**`. When a job
  gains a new input (a file it reads, a new directory), add it to that
  job's filter.
- **`ci-ok` is the check to require**: it fails if any job failed or was
  cancelled; skipped counts as passing.
- **build-web runs even for backend-only PRs**: e2e uses its uploaded build,
  since TanStack Start's prerender can't reach its preview server inside the
  Playwright container.
- **audit** gates at `high`: drizzle-kit carries a moderate advisory via its
  bundled `@esbuild-kit/*` deps with no upstream fix (see the comment in
  `ci.yml`).
- **lighthouse** (`web/scripts/lighthouse.ts`) posts a median-of-3 table:
  performance only warns, accessibility/best practices fail below
  `MIN_SCORES`; it's outside `ci-ok`.
- The **unit** job runs in the Dockerfile's base image, so tests use
  production's ffmpeg.
- CodeQL is its own workflow (`codeql.yml`), reporting to the Security tab.
- The Bun version is pinned once per workflow via `BUN_VERSION`.

## Renovate

`renovate.json5` is the only dependency updater (no `dependabot.yml`): npm
(root + web), GitHub Actions (pinned to SHAs), Docker, Helm values, Helmfile
charts, and regex managers keeping the duplicated Bun version (`Dockerfile`,
`ci.yml`, `tag-release.yml`) and helmfile CLI version (`ci.yml`,
`k8s/observability/README.md`) in sync. The ffmpeg pin lives only in the
`Dockerfile` (`ARG FFMPEG_VERSION`), bumped through the `deb` datasource.
