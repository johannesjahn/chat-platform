import { expect, test } from "bun:test";
import { sanitizeIssues } from "./DecodeErrorSanitizer.ts";

test("sanitizeIssues keeps a Refinement issue's hand-authored message", () => {
  expect(
    sanitizeIssues([
      {
        _tag: "Refinement",
        path: [],
        message:
          "content must be an https:// URL from an allowed image-hosting domain",
      },
    ]),
  ).toEqual([
    {
      _tag: "Refinement",
      path: [],
      message:
        "content must be an https:// URL from an allowed image-hosting domain",
    },
  ]);
});

test("sanitizeIssues replaces a Type issue's structural message with a generic fallback", () => {
  expect(
    sanitizeIssues([
      {
        _tag: "Type",
        path: ["content"],
        message: "Expected string, received number",
      },
    ]),
  ).toEqual([
    {
      _tag: "Type",
      path: ["content"],
      message: "Invalid request",
    },
  ]);
});

test("sanitizeIssues sanitizes each issue independently in a mixed array", () => {
  expect(
    sanitizeIssues([
      { _tag: "Missing", path: ["username"], message: "is missing" },
      {
        _tag: "Refinement",
        path: ["password"],
        message: "must be at least 8 characters",
      },
    ]),
  ).toEqual([
    { _tag: "Missing", path: ["username"], message: "Invalid request" },
    {
      _tag: "Refinement",
      path: ["password"],
      message: "must be at least 8 characters",
    },
  ]);
});

test("sanitizeIssues returns an empty array for no issues", () => {
  expect(sanitizeIssues([])).toEqual([]);
});
