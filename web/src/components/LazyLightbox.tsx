import { type ComponentProps, Suspense } from "react";
import { lazyNamed } from "@/lib/lazy";

const LightboxChunk = lazyNamed(
  () => import("@/components/Lightbox"),
  "Lightbox",
);

// The full-screen image viewer (Lightbox.tsx), loaded on demand (issue
// #754): its gesture handling is a sizeable chunk, and every image post,
// attachment and chat photo would otherwise carry it before anyone opens one.
// It renders into a portal over the page, so there's nothing to hold a place
// for while it loads.
//
// `Lightbox.preload()` starts fetching the chunk. Call it on intent — the
// pointer reaching, or focus landing on, whatever opens the viewer — so the
// click that follows rarely waits on the network.
export const Lightbox = Object.assign(
  function Lightbox(props: ComponentProps<typeof LightboxChunk>) {
    return (
      <Suspense fallback={null}>
        <LightboxChunk {...props} />
      </Suspense>
    );
  },
  { preload: () => void LightboxChunk.preload().catch(() => {}) },
);
