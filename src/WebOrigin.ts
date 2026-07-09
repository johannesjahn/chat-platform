// Origins allowed to talk to this API from a browser. WEB_ORIGIN may hold a
// single origin or a comma-separated list (e.g. a Workers custom domain plus
// its *.workers.dev URL). Shared by the CORS middleware (main.ts) and the
// `/ws` upgrade's Origin check (RealtimeSocket.ts) so the two allowlists
// can't drift apart.
export const allowedOrigins = (
  process.env.WEB_ORIGIN ?? "http://localhost:3001"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
