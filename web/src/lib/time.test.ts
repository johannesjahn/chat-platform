/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { formatRelativeTime } from "./time";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();

const age = (ms: number) => formatRelativeTime(NOW - ms, NOW);

describe("formatRelativeTime", () => {
  test("anything under a minute is 'just now' — never '0m'", () => {
    for (const s of [0, 1, 29, 30, 45, 59]) {
      expect(age(s * SECOND)).toBe("just now");
    }
    expect(age(MINUTE - 1)).toBe("just now");
  });

  test("a timestamp slightly in the future (clock skew) is 'just now'", () => {
    expect(age(-5 * SECOND)).toBe("just now");
  });

  test("minutes from one minute up to an hour", () => {
    expect(age(MINUTE)).toBe("1m");
    expect(age(MINUTE + 59 * SECOND)).toBe("1m");
    expect(age(20 * MINUTE)).toBe("20m");
    expect(age(HOUR - 1)).toBe("59m");
  });

  test("hours, then days, then a short date from a week on", () => {
    expect(age(HOUR)).toBe("1h");
    expect(age(DAY - 1)).toBe("23h");
    expect(age(DAY)).toBe("1d");
    expect(age(7 * DAY - 1)).toBe("6d");
    expect(age(7 * DAY)).not.toMatch(/^\d+[mhd]$/);
  });

  test("no age in the first hour renders '0m'", () => {
    for (let s = 0; s < 3600; s++) {
      expect(age(s * SECOND)).not.toBe("0m");
    }
  });
});
