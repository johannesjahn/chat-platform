import { HttpServerRequest } from "@effect/platform";
import { Config, Effect, Option } from "effect";
import { isIP } from "net";

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
    if (!/^\d{1,3}$/.test(partStr)) return null;
    const part = parseInt(partStr, 10);
    if (part < 0 || part > 255) return null;
    if (String(part) !== partStr) return null;
    num = (num << 8) + part;
  }
  return num >>> 0;
}

/**
 * Checks if a normalized IPv4 address matches an IPv4 CIDR range.
 */
export function isIpv4InCidr(ip: string, cidr: string): boolean {
  if (isIP(ip) !== 4) return false;
  const parts = cidr.split("/");
  const subnetStr = parts[0];
  const maskStr = parts[1];
  if (subnetStr === undefined) return false;
  if (isIP(subnetStr) !== 4) return false;

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
  if (isIP(ip) === 0) return false;

  const rules = trustProxyEnv.split(",").map((r) => r.trim());
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
      // TODO: Support IPv6 CIDR parsing and matching
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
  const fallbackIp = remoteAddress ? normalizeIp(remoteAddress) : "unknown";
  const initialIp = isIP(fallbackIp) !== 0 ? fallbackIp : "unknown";

  if (trustProxyEnv === undefined || trustProxyEnv === "") {
    return initialIp;
  }

  const trustProxy = trustProxyEnv;
  if (initialIp === "unknown" || !isTrustedProxy(initialIp, trustProxy)) {
    return initialIp;
  }

  const xForwardedFor = headers["x-forwarded-for"];
  if (xForwardedFor) {
    const ips = xForwardedFor.split(",").map((item) => normalizeIp(item));
    // Right-to-left traversal of proxies in the chain.
    // The leftmost non-matching IP is the client IP.
    for (let i = ips.length - 1; i >= 0; i--) {
      const currentIp = ips[i];
      if (currentIp !== undefined && isIP(currentIp) !== 0) {
        if (!isTrustedProxy(currentIp, trustProxy)) {
          return currentIp;
        }
      }
    }
    // Fallback: if all valid IPs in the chain were trusted proxies, return the leftmost valid IP.
    for (let i = 0; i < ips.length; i++) {
      const currentIp = ips[i];
      if (currentIp !== undefined && isIP(currentIp) !== 0) {
        return currentIp;
      }
    }
  }

  const xRealIp = headers["x-real-ip"];
  if (xRealIp) {
    const parsedXRealIp = normalizeIp(xRealIp);
    if (isIP(parsedXRealIp) !== 0) {
      return parsedXRealIp;
    }
  }

  return initialIp;
}

/**
 * Effect helper to retrieve the client IP from the current HttpServerRequest context.
 */
export const clientIp = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const trustProxyEnv = yield* Config.string("TRUST_PROXY").pipe(
    Config.option,
    Effect.catchAll(() => Effect.succeed(Option.none())),
    Effect.map(Option.getOrUndefined),
  );
  const remoteAddress = Option.getOrUndefined(request.remoteAddress);
  return getClientIp(remoteAddress, request.headers, trustProxyEnv);
});
