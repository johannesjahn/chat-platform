// A static server for the production build (dist/client), standing in for
// the Cloudflare deploy: the SPA fallback wrangler.jsonc configures
// ("not_found_handling": "single-page-application"), so a deep link like
// /chats/123 gets index.html. Shared by lighthouse.ts and serve-build.ts (the
// e2e suite's `E2E_TARGET=build` web server).
//
// Not `vite preview`: with TanStack Start's plugin it serves through the SSR
// bundle in dist/server, which the static deploy never uses — and which CI's
// `web-dist` artifact doesn't carry.
import path from "node:path";

export const DIST = "dist/client";

const COMPRESSIBLE = /\.(html|js|css|json|svg|webmanifest|txt)$/;

export function serveBuild({
  port,
  gzip = false,
}: {
  port: number;
  // Compress text responses as Cloudflare does. Lighthouse wants it (an
  // uncompressed local server would make the build look several times
  // slower); the e2e suite doesn't, and skips the per-request cost.
  gzip?: boolean;
}) {
  const root = path.resolve(DIST);

  async function serveStatic(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const resolved = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    let file = Bun.file(resolved);
    let name = resolved;
    if (
      pathname === "/" ||
      !resolved.startsWith(root + path.sep) ||
      !(await file.exists())
    ) {
      name = path.join(root, "index.html");
      file = Bun.file(name);
    }
    const headers = new Headers({ "content-type": file.type });
    if (
      gzip &&
      COMPRESSIBLE.test(name) &&
      request.headers.get("accept-encoding")?.includes("gzip")
    ) {
      headers.set("content-encoding", "gzip");
      return new Response(Bun.gzipSync(await file.bytes()), { headers });
    }
    return new Response(file, { headers });
  }

  return Bun.serve({ port, fetch: serveStatic });
}
