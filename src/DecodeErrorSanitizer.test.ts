import { expect, test } from "bun:test";
import { sanitizedMessage } from "./DecodeErrorSanitizer.ts";

test("sanitizedMessage keeps a Refinement issue's hand-authored message", () => {
  expect(
    sanitizedMessage({
      _tag: "Refinement",
      path: [],
      message:
        "content must be an https:// URL from an allowed image-hosting domain",
    }),
  ).toBe(
    "content must be an https:// URL from an allowed image-hosting domain",
  );
});

test("sanitizedMessage replaces a Type issue's structural message with a generic fallback", () => {
  expect(
    sanitizedMessage({
      _tag: "Type",
      path: ["content"],
      message: "Expected string, received number",
    }),
  ).toBe("Invalid request");
});

test("sanitizedMessage falls back to a generic message when there are no issues", () => {
  expect(sanitizedMessage(undefined)).toBe("Invalid request");
});
