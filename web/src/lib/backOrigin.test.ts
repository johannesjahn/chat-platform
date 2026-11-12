/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { AnyRouter } from "@tanstack/react-router";
import { backLabel, canGoBackTo } from "./backOrigin";

describe("backLabel", () => {
  test("names the page Back returns to", () => {
    expect(backLabel("/")).toBe("Back to feed");
    expect(backLabel("/search")).toBe("Back to search");
    expect(backLabel("/notifications")).toBe("Back to notifications");
    expect(backLabel("/users")).toBe("Back to users");
    expect(backLabel("/users/42")).toBe("Back to profile");
    expect(backLabel("/chats")).toBe("Back to chats");
    expect(backLabel("/chats/7")).toBe("Back to chat");
    expect(backLabel("/posts/3")).toBe("Back to post");
  });

  test("goes by the path, whatever the search or hash", () => {
    expect(backLabel("/search?q=falcon")).toBe("Back to search");
    expect(backLabel("/?post=3")).toBe("Back to feed");
    expect(backLabel("/users/42#posts")).toBe("Back to profile");
  });

  test("is a plain Back for an unknown or unnamed origin", () => {
    expect(backLabel(undefined)).toBe("Back");
    expect(backLabel("/games/typing")).toBe("Back");
    expect(backLabel("/users/42/followers")).toBe("Back");
  });
});

describe("canGoBackTo", () => {
  const router = (canGoBack: boolean) =>
    ({ history: { canGoBack: () => canGoBack } }) as unknown as AnyRouter;

  test("needs an in-app entry to go back to", () => {
    expect(canGoBackTo(router(false), "/search")).toBe(false);
    expect(canGoBackTo(router(true), "/search")).toBe(true);
    // A reload with no recorded origin still has the entry behind it.
    expect(canGoBackTo(router(true), undefined)).toBe(true);
  });

  test("never bounces back onto the auth page that sent the user here", () => {
    expect(canGoBackTo(router(true), "/login")).toBe(false);
    expect(canGoBackTo(router(true), "/register")).toBe(false);
    expect(canGoBackTo(router(true), "/login?redirect=%2Fposts%2F3")).toBe(
      false,
    );
  });
});
