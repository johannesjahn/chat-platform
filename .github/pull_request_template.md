## Summary

<!-- What does this PR do and why? -->

## Related issue

Fixes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Documentation
- [ ] CI / tooling
- [ ] Other (describe above)

## Manual steps

<!-- Anything CI won't do for you: migrations to run, config/secrets to set, a manual deploy step, etc. Leave as "None" if not applicable. -->

## Checklist

- [ ] Tests pass (`bun test ./src --parallel --timeout=15000` and, if applicable, `cd web && bun run test:e2e`)
- [ ] `typecheck` passes for each affected package (backend: `bun run typecheck`; web: `cd web && bun run typecheck`, after `bun run gen:routes`)
- [ ] If the backend API changed, `openapi.json` and `web/src/lib/api-types.ts` were regenerated (`bun run gen:openapi` and `cd web && bun run gen:types`) and committed
- [ ] Lint and format are clean (`bun run lint` and `bun run format:check`)
