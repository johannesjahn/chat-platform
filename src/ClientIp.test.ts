import { expect, test, describe } from "bun:test";
import {
  normalizeIp,
  isIpv4InCidr,
  isTrustedProxy,
  getClientIp,
} from "./ClientIp.ts";

describe("ClientIp", () => {
  test("normalizeIp strips ::ffff: prefix and trims spaces", () => {
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("  ::ffff:192.168.1.1  ")).toBe("192.168.1.1");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeIp("127.0.0.1")).toBe("127.0.0.1");
  });

  test("isIpv4InCidr correctly checks IPv4 subnet matches", () => {
    // /32 exact match
    expect(isIpv4InCidr("192.168.1.1", "192.168.1.1/32")).toBe(true);
    expect(isIpv4InCidr("192.168.1.2", "192.168.1.1/32")).toBe(false);

    // /24 subnet match
    expect(isIpv4InCidr("192.168.1.15", "192.168.1.0/24")).toBe(true);
    expect(isIpv4InCidr("192.168.2.15", "192.168.1.0/24")).toBe(false);

    // /8 subnet match
    expect(isIpv4InCidr("10.5.5.5", "10.0.0.0/8")).toBe(true);
    expect(isIpv4InCidr("11.5.5.5", "10.0.0.0/8")).toBe(false);

    // /12 subnet match (172.16.0.0 - 172.31.255.255)
    expect(isIpv4InCidr("172.16.0.1", "172.16.0.0/12")).toBe(true);
    expect(isIpv4InCidr("172.31.255.255", "172.16.0.0/12")).toBe(true);
    expect(isIpv4InCidr("172.32.0.1", "172.16.0.0/12")).toBe(false);

    // /0 matches everything
    expect(isIpv4InCidr("8.8.8.8", "0.0.0.0/0")).toBe(true);

    // Invalid IP/Subnets should return false
    expect(isIpv4InCidr("invalid", "10.0.0.0/8")).toBe(false);
    expect(isIpv4InCidr("10.0.0.1", "invalid/8")).toBe(false);
  });

  test("isTrustedProxy correctly matches rules", () => {
    // Boolean true
    expect(isTrustedProxy("1.2.3.4", "true")).toBe(true);
    expect(isTrustedProxy("1.2.3.4", "1")).toBe(true);

    // Boolean false
    expect(isTrustedProxy("1.2.3.4", "false")).toBe(false);
    expect(isTrustedProxy("1.2.3.4", "0")).toBe(false);

    // Loopback keyword
    expect(isTrustedProxy("127.0.0.1", "loopback")).toBe(true);
    expect(isTrustedProxy("127.0.0.2", "loopback")).toBe(true);
    expect(isTrustedProxy("::1", "loopback")).toBe(true);
    expect(isTrustedProxy("10.0.0.1", "loopback")).toBe(false);

    // Specific IPs and subnets list
    const rules = "10.0.0.1, 192.168.1.0/24, loopback";
    expect(isTrustedProxy("10.0.0.1", rules)).toBe(true);
    expect(isTrustedProxy("10.0.0.2", rules)).toBe(false);
    expect(isTrustedProxy("192.168.1.150", rules)).toBe(true);
    expect(isTrustedProxy("192.168.2.1", rules)).toBe(false);
    expect(isTrustedProxy("127.0.0.1", rules)).toBe(true);
  });

  test("getClientIp behaves correctly for various configuration scenarios", () => {
    const headersEmpty = {};
    const headersXFFOnly = { "x-forwarded-for": "8.8.8.8, 10.0.0.2" };
    const headersXRIOnly = { "x-real-ip": "7.7.7.7" };
    const headersBoth = {
      "x-forwarded-for": "8.8.8.8, 10.0.0.2",
      "x-real-ip": "7.7.7.7",
    };

    // 1. TRUST_PROXY is undefined or empty
    expect(getClientIp("10.0.0.1", headersXFFOnly, undefined)).toBe("10.0.0.1");
    expect(getClientIp("10.0.0.1", headersXFFOnly, "")).toBe("10.0.0.1");

    // 2. TRUST_PROXY is false
    expect(getClientIp("10.0.0.1", headersXFFOnly, "false")).toBe("10.0.0.1");

    // 3. TRUST_PROXY is true (trusts any proxy)
    // Leftmost from X-Forwarded-For
    expect(getClientIp("10.0.0.1", headersBoth, "true")).toBe("8.8.8.8");
    // X-Real-IP fallback
    expect(getClientIp("10.0.0.1", headersXRIOnly, "true")).toBe("7.7.7.7");
    // remoteAddress fallback
    expect(getClientIp("10.0.0.1", headersEmpty, "true")).toBe("10.0.0.1");

    // 4. TRUST_PROXY is a CIDR list (e.g. 10.0.0.0/8)
    // Case 4a: immediate peer is NOT trusted
    expect(getClientIp("8.8.8.8", headersBoth, "10.0.0.0/8")).toBe("8.8.8.8");

    // Case 4b: immediate peer is trusted, XFF contains untrusted client IP
    // remoteAddress is 10.0.0.1 (trusted), XFF has "8.8.8.8, 10.0.0.2".
    // 10.0.0.2 is trusted. 8.8.8.8 is untrusted -> should return 8.8.8.8.
    expect(getClientIp("10.0.0.1", headersXFFOnly, "10.0.0.0/8")).toBe(
      "8.8.8.8",
    );

    // Case 4c: immediate peer is trusted, XFF contains multiple untrusted/trusted IPs
    // XFF has "8.8.8.8, 9.9.9.9, 10.0.0.2".
    // 10.0.0.2 is trusted. 9.9.9.9 is untrusted -> returns 9.9.9.9.
    const headersXFFMultiple = {
      "x-forwarded-for": "8.8.8.8, 9.9.9.9, 10.0.0.2",
    };
    expect(getClientIp("10.0.0.1", headersXFFMultiple, "10.0.0.0/8")).toBe(
      "9.9.9.9",
    );

    // Case 4d: immediate peer is trusted, XFF has only trusted IPs
    // XFF has "10.0.0.3, 10.0.0.2". All are trusted. Returns leftmost.
    const headersXFFAllTrusted = {
      "x-forwarded-for": "10.0.0.3, 10.0.0.2",
    };
    expect(getClientIp("10.0.0.1", headersXFFAllTrusted, "10.0.0.0/8")).toBe(
      "10.0.0.3",
    );

    // Case 4e: fallback to X-Real-IP if peer is trusted and XFF is missing
    expect(getClientIp("10.0.0.1", headersXRIOnly, "10.0.0.0/8")).toBe(
      "7.7.7.7",
    );
  });
});
