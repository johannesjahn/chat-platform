import { HttpApiBuilder, HttpApiError, type HttpApp } from "@effect/platform";
import { Effect } from "effect";
import { ChatApi } from "./Api.ts";

type Issue = HttpApiError.HttpApiDecodeError["issues"][number];

const GENERIC_MESSAGE = "Invalid request";

// `HttpApiDecodeError.message` is `ParseResult.TreeFormatter.formatError` by
// default — a multi-line, internal parse trace (schema/type names, refinement
// structure) that's never meant to reach an end user. `issues` is the
// structured `ParseResult.ArrayFormatter` output instead: one issue per
// failed node, each with its own `message` — but that per-issue `message`
// is just as raw/internal as the tree dump unless we sanitize it too, since
// `web/src/lib/errors.ts` reads straight from `issues` rather than the
// top-level `message`.
//
// Only a "Refinement"-tagged issue carries a hand-authored message — that
// tag only survives into the array-formatter output when the failing
// `Schema.filter`/`Schema.pattern`/etc. supplied a custom `message`
// annotation (see `getArrayFormatterIssues` in effect's ParseResult.ts).
// Anything else (typically "Type", for a plain structural mismatch like
// "Expected string, received number") has no hand-authored string, so it's
// replaced with a generic message rather than leaked.
const sanitizeIssue = (issue: Issue): Issue =>
  issue._tag === "Refinement" ? issue : { ...issue, message: GENERIC_MESSAGE };

export const sanitizeIssues = (issues: ReadonlyArray<Issue>): Issue[] =>
  issues.map(sanitizeIssue);

// Replaces the raw parse trace on every `HttpApiDecodeError` (path/query/body
// schema decode failures) with a clean, safe message before it's serialized —
// both the top-level `message` and every entry in `issues` — so no internal
// detail reaches any API consumer, not just the browser clients
// `web/src/lib/errors.ts` special-cases.
export const SanitizeDecodeErrorsLive = HttpApiBuilder.middleware(
  ChatApi,
  // `MiddlewareFn`'s input is typed as the failure-erased `HttpApp.Default`
  // (its type param defaults to `never`) even though, at the point this
  // global middleware actually runs — wrapping the router before the
  // top-level `Effect.catchAllCause`/error-encoding step — a request can
  // still fail with `HttpApiDecodeError` same as any handler-level error.
  // The cast reflects that real failure channel so `catchTag` below can see it.
  (httpApp) =>
    Effect.catchTag(
      httpApp as HttpApp.Default<HttpApiError.HttpApiDecodeError>,
      "HttpApiDecodeError",
      (error) => {
        const issues = sanitizeIssues(error.issues);
        return Effect.fail(
          new HttpApiError.HttpApiDecodeError({
            issues,
            message: issues[0]?.message ?? GENERIC_MESSAGE,
          }),
        );
      },
    ),
);
