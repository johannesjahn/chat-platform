import { $api } from "@/lib/api";

// Small, unobtrusive build-version tag — pinned to the corner so it's
// visible without competing with the page content. Backed by `GET /version`
// (see `src/VersionHandler.ts`) rather than a bundled constant so it always
// reflects what the *running backend* was built from.
export function VersionFooter() {
  const { data } = $api.useQuery("get", "/version");
  if (!data) return null;

  return (
    // Offset from the *top* by `--app-height` rather than anchored with
    // `bottom-2`: a fixed element resolves against the layout viewport, which
    // on iOS keeps its full height while the on-screen keyboard is up, so
    // "the bottom" is somewhere behind the keyboard and the tag ends up
    // floating in the middle of the screen — over the composer's send button
    // in a chat. `--app-height` is the visible viewport (lib/viewport.ts), and
    // its top edge is the layout viewport's, so measuring down from there puts
    // this back on the bottom edge people can actually see.
    // Hidden below `sm`: pages run edge to edge on a phone, so there's no empty
    // margin for the corner to sit in and the tag lands on whatever card is at
    // the bottom of the screen (#506). Hidden again from `lg`, where the
    // desktop sidebar carries the tag instead (issue #554) and this corner
    // is a full-width conversation's send button.
    <span
      data-version-tag
      className="pointer-events-none fixed top-[calc(var(--app-height,100dvh)-1.5rem)] right-3 z-10 hidden text-xs text-muted-foreground/60 select-none sm:inline lg:hidden"
    >
      v{data.version}
    </span>
  );
}
