/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { isImeComposing } from "./ime";

describe("isImeComposing", () => {
  test("native event: isComposing", () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  test("native event: Safari's confirming keydown (keyCode 229)", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  test("native event: a plain Enter isn't composing", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposing({})).toBe(false);
  });

  test("React event: reads nativeEvent", () => {
    expect(
      isImeComposing({ nativeEvent: { isComposing: true, keyCode: 13 } }),
    ).toBe(true);
    expect(
      isImeComposing({ nativeEvent: { isComposing: false, keyCode: 229 } }),
    ).toBe(true);
    expect(
      isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 } }),
    ).toBe(false);
  });

  test("React event: the native event wins over the synthetic fields", () => {
    const reactLike = {
      key: "Enter",
      keyCode: 13,
      nativeEvent: { key: "Enter", isComposing: true, keyCode: 229 },
    };
    expect(isImeComposing(reactLike)).toBe(true);
  });
});
