/// <reference types="bun" />
import { expect, test } from "bun:test";
import { isLongText, MESSAGE_COLLAPSE, POST_COLLAPSE } from "./longText";

test("a text past the character budget is long", () => {
  expect(isLongText("a".repeat(500), POST_COLLAPSE)).toBe(false);
  expect(isLongText("a".repeat(501), POST_COLLAPSE)).toBe(true);
});

// Issue #898: 40 one-word lines are well under 500 characters but far taller
// than the six lines the clamp shows.
test("a text with more lines than the clamp shows is long", () => {
  expect(isLongText(Array(40).fill("word").join("\n"), POST_COLLAPSE)).toBe(
    true,
  );
  expect(isLongText(Array(6).fill("word").join("\n"), POST_COLLAPSE)).toBe(
    false,
  );
  expect(isLongText(Array(7).fill("word").join("\n"), POST_COLLAPSE)).toBe(
    true,
  );
  expect(isLongText("a\nb\nc\nd", MESSAGE_COLLAPSE)).toBe(false);
  expect(isLongText("a\nb\nc\nd\ne", MESSAGE_COLLAPSE)).toBe(true);
});

test("no text is never long", () => {
  expect(isLongText(null, POST_COLLAPSE)).toBe(false);
  expect(isLongText(undefined, POST_COLLAPSE)).toBe(false);
  expect(isLongText("", POST_COLLAPSE)).toBe(false);
});
