import { expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { sanitizeIssues } from "./DecodeErrorSanitizer.ts";

const issuesFor = <S extends Schema.Decoder<unknown>>(
  schema: S,
  input: unknown,
) => {
  const result = Schema.decodeUnknownResult(schema)(input, {
    errors: "all",
  });
  if (Result.isSuccess(result)) throw new Error("expected a decode failure");
  return sanitizeIssues(result.failure.issue);
};

test("sanitizeIssues keeps a filter's hand-authored message", () => {
  const Content = Schema.String.check(
    Schema.makeFilter(() => "content must be an https:// URL"),
  );
  expect(
    issuesFor(Schema.Struct({ content: Content }), { content: "x" }),
  ).toEqual([
    {
      _tag: "Refinement",
      path: ["content"],
      message: "content must be an https:// URL",
    },
  ]);
});

test("sanitizeIssues replaces a structural type mismatch with a generic message", () => {
  const issues = issuesFor(Schema.Struct({ content: Schema.String }), {
    content: 12345,
  });
  expect(issues).toEqual([
    { _tag: "Type", path: ["content"], message: "Invalid request" },
  ]);
  expect(JSON.stringify(issues)).not.toContain("Expected");
});

test("sanitizeIssues replaces a built-in check's message too", () => {
  expect(
    issuesFor(Schema.String.check(Schema.isMaxLength(2)), "too long"),
  ).toEqual([{ _tag: "Type", path: [], message: "Invalid request" }]);
});

test("sanitizeIssues sanitizes each issue independently", () => {
  const Body = Schema.Struct({
    username: Schema.String,
    password: Schema.String.check(
      Schema.makeFilter((s) =>
        s.length >= 8 ? undefined : "must be at least 8 characters",
      ),
    ),
  });
  expect(issuesFor(Body, { password: "short" })).toEqual([
    { _tag: "Type", path: ["username"], message: "Invalid request" },
    {
      _tag: "Refinement",
      path: ["password"],
      message: "must be at least 8 characters",
    },
  ]);
});
