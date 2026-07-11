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

  test("isIpv4InCidr correctly checks IPv4 subnet matches with strict octet checking", () => {
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

    // Guard against loose octets (e.g. parseInt accepting "1a" as 1)
    expect(isIpv4InCidr("1a.0.0.1", "1.0.0.0/8")).toBe(false);
    expect(isIpv4InCidr("1.0.0.1", "1a.0.0.0/8")).toBe(false);
    expect(isIpv4InCidr("1.0.0.01", "1.0.0.0/8")).toBe(false); // Reject leading zeros

    // Invalid IP/Subnets should return false
    expect(isIpv4InCidr("invalid", "10.0.0.0/8")).toBe(false);
    expect(isIpv4InCidr("10.0.0.1", "invalid/8")).toBe(false);
  });

  test("isTrustedProxy correctly matches rules and rejects invalid formats", () => {
    // Explicit global trust via 0.0.0.0/0 CIDR
    expect(isTrustedProxy("1.2.3.4", "0.0.0.0/0")).toBe(true);

    // Dropped boolean shortcuts (should return false now since they are not valid IPs/CIDRs)
    expect(isTrustedProxy("1.2.3.4", "true")).toBe(false);
    expect(isTrustedProxy("1.2.3.4", "1")).toBe(false);

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

    // Guard against malformed IP rules
    expect(isTrustedProxy("1.0.0.1", "1a.0.0.1")).toBe(false);
  });

  test("getClientIp behaves correctly and strictly validates IP shapes", () => {
    const headersXFFOnly = { "x-forwarded-for": "8.8.8.8, 10.0.0.2" };
    const headersBoth = {
      "x-forwarded-for": "8.8.8.8, 10.0.0.2",
      "x-real-ip": "7.7.7.7",
    };

    // 1. TRUST_PROXY is undefined or empty
    expect(getClientIp("10.0.0.1", headersXFFOnly, undefined)).toBe("10.0.0.1");
    expect(getClientIp("10.0.0.1", headersXFFOnly, "")).toBe("10.0.0.1");

    // 2. TRUST_PROXY is false (doesn't match since it's not a valid rule)
    expect(getClientIp("10.0.0.1", headersXFFOnly, "false")).toBe("10.0.0.1");

    // 3. TRUST_PROXY explicitly trusts all via CIDR 0.0.0.0/0
    expect(getClientIp("10.0.0.1", headersBoth, "0.0.0.0/0")).toBe("8.8.8.8");

    // 4. Shape validation on X-Forwarded-For candidates
    // If a candidate is "totally-not-an-ip", it should be skipped and getClientIp should fall back to the trusted remoteAddress
    expect(
      getClientIp(
        "10.0.0.1",
        { "x-forwarded-for": "totally-not-an-ip" },
        "10.0.0.0/8",
      ),
    ).toBe("10.0.0.1");
    expect(
      getClientIp(
        "10.0.0.1",
        { "x-forwarded-for": "totally-not-an-ip, 10.0.0.2" },
        "10.0.0.0/8",
      ),
    ).toBe("10.0.0.2"); // 10.0.0.2 is valid, totally-not-an-ip is skipped

    // 5. TRUST_PROXY is a CIDR list (e.g. 10.0.0.0/8)
    // Case 5a: immediate peer is NOT trusted
    expect(getClientIp("8.8.8.8", headersBoth, "10.0.0.0/8")).toBe("8.8.8.8");

    // Case 5b: immediate peer is trusted, XFF contains untrusted client IP
    expect(getClientIp("10.0.0.1", headersXFFOnly, "10.0.0.0/8")).toBe(
      "8.8.8.8",
    );

    // Case 5c: immediate peer is trusted, XFF contains multiple untrusted/trusted IPs
    const headersXFFMultiple = {
      "x-forwarded-for": "8.8.8.8, 9.9.9.9, 10.0.0.2",
    };
    expect(getClientIp("10.0.0.1", headersXFFMultiple, "10.0.0.0/8")).toBe(
      "9.9.9.9",
    );

    // Case 5d: immediate peer is trusted, XFF has only trusted IPs
    const headersXFFAllTrusted = {
      "x-forwarded-for": "10.0.0.3, 10.0.0.2",
    };
    expect(getClientIp("10.0.0.1", headersXFFAllTrusted, "10.0.0.0/8")).toBe(
      "10.0.0.3",
    );
  });
});
