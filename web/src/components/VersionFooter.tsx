import { $api } from "@/lib/api";

// Small, unobtrusive build-version tag — pinned to the corner so it's
// visible without competing with the page content. Backed by `GET /version`
// (see `src/VersionHandler.ts`) rather than a bundled constant so it always
// reflects what the *running backend* was built from.
export function VersionFooter() {
  const { data } = $api.useQuery("get", "/version");
  if (!data) return null;

  return (
    <span className="pointer-events-none fixed bottom-2 right-3 z-10 text-xs text-muted-foreground/60 select-none">
      v{data.version}
    </span>
  );
}
