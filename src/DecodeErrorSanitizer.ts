import { HttpApiMiddleware } from "effect/http-api";
import { Effect, SchemaIssue } from "effect";
import { HttpApiDecodeError, SanitizeDecodeErrors } from "./Api.ts";

type Issue = HttpApiDecodeError["issues"][number];

const GENERIC_MESSAGE = "Invalid request";

// effect's default issue messages are raw, internal parse output (schema/type
// names, the offending input) that's never meant to reach an end user —
// `web/src/lib/errors.ts` shows `issues[].message` as-is.
//
// Only a failed check that carries its own `message` (a hand-authored string
// returned from a `Schema.makeFilter`, or a `message` annotation) is kept —
// that's what `defaultCheckHook` returns, `undefined` otherwise. Anything else
// (a plain structural mismatch like "Expected string, got 12345", a missing
// key, a built-in check like `isMaxLength`) has no hand-authored string, so
// it's replaced with a generic message rather than leaked.
const format = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: () => GENERIC_MESSAGE,
  checkHook: (issue) => SchemaIssue.defaultCheckHook(issue) ?? GENERIC_MESSAGE,
});

export const sanitizeIssues = (issue: SchemaIssue.Issue): Issue[] =>
  format(issue).issues.map(({ path, message }) => ({
    _tag: message === GENERIC_MESSAGE ? "Type" : "Refinement",
    path: (path ?? []).map((segment) => {
      const key = typeof segment === "object" ? segment.key : segment;
      return typeof key === "number" ? key : String(key);
    }),
    message,
  }));

// Replaces every request decode failure (path/query/header/body) — which v4
// would otherwise answer with an empty 400 — with a clean, safe
// HttpApiDecodeError: both the top-level `message` and every entry in
// `issues`, so no internal detail reaches any API consumer.
export const SanitizeDecodeErrorsLive =
  HttpApiMiddleware.layerSchemaErrorTransform(SanitizeDecodeErrors, (error) => {
    const issues = sanitizeIssues(error.cause.issue);
    return Effect.fail(
      new HttpApiDecodeError({
        issues,
        message: issues[0]?.message ?? GENERIC_MESSAGE,
      }),
    );
  });
