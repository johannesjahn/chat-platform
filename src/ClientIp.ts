import { HttpServerRequest } from "@effect/platform";
import { Effect, Option } from "effect";

/**
 * Normalizes an IP address by stripping IPv6-mapped IPv4 prefix (::ffff:)
 * and trimming whitespace.
 */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice(7);
  }
  return trimmed;
}

/**
 * Parses an IPv4 address string into a 32-bit unsigned integer.
 * Returns null if the format is invalid.
 */
function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (let i = 0; i < 4; i++) {
    const partStr = parts[i];
    if (partStr === undefined) return null;
    const part = parseInt(partStr, 10);
    if (isNaN(part) || part < 0 || part > 255) return null;
    num = (num << 8) + part;
  }
  return num >>> 0;
}

/**
 * Checks if a normalized IPv4 address matches an IPv4 CIDR range.
 */
export function isIpv4InCidr(ip: string, cidr: string): boolean {
  const parts = cidr.split("/");
  const subnetStr = parts[0];
  const maskStr = parts[1];
  if (subnetStr === undefined) return false;

  const ipNum = parseIpv4(ip);
  const subnetNum = parseIpv4(subnetStr);
  if (ipNum === null || subnetNum === null) return false;

  const mask = maskStr ? parseInt(maskStr, 10) : 32;
  if (isNaN(mask) || mask < 0 || mask > 32) return false;

  if (mask === 0) return true;
  const shift = 32 - mask;
  // Node / JS bitwise shift on 32-bit integers returns signed integer.
  // We use `>>> 0` to treat them as unsigned.
  const maskBuffer = (0xffffffff << shift) >>> 0;
  return (ipNum & maskBuffer) === (subnetNum & maskBuffer);
}

/**
 * Checks if a client IP matches the configured TRUST_PROXY environment rules.
 */
export function isTrustedProxy(ip: string, trustProxyEnv: string): boolean {
  const normalized = trustProxyEnv.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }

  const rules = normalized.split(",").map((r) => r.trim());
  for (const rule of rules) {
    if (rule === "loopback") {
      if (ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.")) {
        return true;
      }
    }
    const normalizedRule = normalizeIp(rule);
    if (ip === normalizedRule) {
      return true;
    }
    if (rule.includes("/")) {
      if (isIpv4InCidr(ip, rule)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolves the client IP from connection details and request headers.
 */
export function getClientIp(
  remoteAddress: string | undefined,
  headers: Record<string, string | undefined>,
  trustProxyEnv: string | undefined,
): string {
  const ip = remoteAddress ? normalizeIp(remoteAddress) : "unknown";
  if (trustProxyEnv === undefined || trustProxyEnv === "") {
    return ip;
  }

  const trustProxy = trustProxyEnv;
  if (!isTrustedProxy(ip, trustProxy)) {
    return ip;
  }

  const xForwardedFor = headers["x-forwarded-for"];
  if (xForwardedFor) {
    const ips = xForwardedFor.split(",").map((item) => normalizeIp(item));
    const normalizedTrustProxy = trustProxy.trim().toLowerCase();
    if (normalizedTrustProxy === "true" || normalizedTrustProxy === "1") {
      const first = ips[0];
      if (first !== undefined) {
        return first;
      }
    } else {
      // Right-to-left traversal of proxies in the chain.
      // The leftmost non-matching IP is the client IP.
      for (let i = ips.length - 1; i >= 0; i--) {
        const currentIp = ips[i];
        if (currentIp !== undefined && !isTrustedProxy(currentIp, trustProxy)) {
          return currentIp;
        }
      }
      const first = ips[0];
      if (first !== undefined) {
        return first;
      }
    }
  }

  const xRealIp = headers["x-real-ip"];
  if (xRealIp) {
    return normalizeIp(xRealIp);
  }

  return ip;
}

/**
 * Effect helper to retrieve the client IP from the current HttpServerRequest context.
 */
export const clientIp = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const trustProxyEnv = process.env.TRUST_PROXY;
  const remoteAddress = Option.getOrUndefined(request.remoteAddress);
  return getClientIp(remoteAddress, request.headers, trustProxyEnv);
});
