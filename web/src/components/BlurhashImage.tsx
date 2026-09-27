import { decode } from "blurhash";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type BlurhashImageProps = {
  src: string;
  alt: string;
  width?: number | null;
  height?: number | null;
  blurhash?: string | null;
  className?: string;
};

// BlurHash placeholder is decoded at a tiny fixed resolution and stretched
// via CSS — it's meant to read as a soft blur, not a sharp thumbnail.
const CANVAS_SIZE_PX = 32;

// Both the canvas placeholder and the `<img>` are absolutely positioned (so
// they can crossfade in the same box), which means the container needs an
// explicit aspect ratio to have any height at all before the image loads.
// Falls back to this when `width`/`height` aren't known (attachments
// uploaded before issue #248, or a caller that hasn't wired them through).
const FALLBACK_ASPECT_RATIO = "4 / 3";

// Renders an `<img>` over a BlurHash-decoded canvas placeholder, crossfading
// to the real image once it loads instead of popping in over a flat
// `bg-muted` box (issue #248). `width`/`height` (when known) fix the
// container's aspect ratio up front so nothing shifts as the image loads.
//
// A new `src` for an image that's already on screen — in practice the same
// attachment under a re-signed presigned URL once the old one nears expiry
// (see lib/stableAttachmentUrls.ts) — must not drop back to the blur: the
// new URL is loaded and decoded off-screen and only swapped in once it can
// paint immediately, so the visible pixels never go away. A `src` change
// before anything has loaded just switches straight over.
//
// Likewise an image the browser already has (the same card re-rendered after
// navigating away and back) is shown as-is on mount — no blur placeholder, no
// fade/blur-in replay — so returning to a page doesn't look like it reloaded.
export function BlurhashImage({
  src,
  alt,
  width,
  height,
  blurhash,
  className,
}: BlurhashImageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // The `src` actually rendered, whether its pixels have loaded, and whether
  // they were there without a visible load (browser cache, or a swap below)
  // — in which case there's nothing to animate in.
  const [shown, setShown] = useState({ src, loaded: false, instant: false });

  // Nothing painted yet, so there's nothing to keep on screen — adopt the
  // new `src` during render rather than in an effect (React's "adjusting
  // state when a prop changes" pattern), so there's no frame of the old one.
  if (src !== shown.src && !shown.loaded) {
    setShown({ src, loaded: false, instant: false });
  }

  // Already decoded from the browser's image cache by the time we commit:
  // mark it loaded before the first paint instead of fading it in from the
  // placeholder.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (shown.loaded || !img?.complete || img.naturalWidth === 0) return;
    setShown({ src: shown.src, loaded: true, instant: true });
  }, [shown.src, shown.loaded]);

  useEffect(() => {
    if (src === shown.src || !shown.loaded) return;
    let cancelled = false;
    const next = new Image();
    next.src = src;
    next.decode().then(
      () => {
        if (!cancelled) setShown({ src, loaded: true, instant: true });
      },
      // Broken/expired new URL: switch anyway so the `<img>` reflects the
      // real `src` (and its failure) rather than silently pinning the old one.
      () => {
        if (!cancelled) setShown({ src, loaded: false, instant: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [src, shown.src, shown.loaded]);

  const { loaded, instant } = shown;

  useEffect(() => {
    if (!blurhash) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    try {
      const pixels = decode(blurhash, CANVAS_SIZE_PX, CANVAS_SIZE_PX);
      const imageData = ctx.createImageData(CANVAS_SIZE_PX, CANVAS_SIZE_PX);
      imageData.data.set(pixels);
      ctx.putImageData(imageData, 0, 0);
    } catch {
      // Malformed hash (shouldn't happen — server-generated) — the
      // `bg-muted` fallback on the container covers for it.
    }
  }, [blurhash]);

  return (
    <div
      className={cn("relative overflow-hidden bg-muted", className)}
      style={{
        aspectRatio:
          width && height ? `${width} / ${height}` : FALLBACK_ASPECT_RATIO,
      }}
    >
      {blurhash && (
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE_PX}
          height={CANVAS_SIZE_PX}
          aria-hidden="true"
          className={cn(
            "absolute inset-0 h-full w-full object-cover",
            !instant && "transition-opacity duration-300",
            loaded ? "opacity-0" : "opacity-100",
          )}
        />
      )}
      <img
        ref={imgRef}
        src={shown.src}
        alt={alt}
        loading="lazy"
        onLoad={() => {
          const loadedSrc = shown.src;
          setShown((current) =>
            current.src === loadedSrc ? { ...current, loaded: true } : current,
          );
        }}
        className={cn(
          "absolute inset-0 h-full w-full object-cover",
          !instant && "transition-opacity duration-300",
          loaded ? "opacity-100" : "opacity-0",
          // The real pixels resolve *out of* the blur they're replacing
          // rather than fading in over it as a second, already-sharp layer —
          // it's the same gesture the placeholder was standing in for, so the
          // hand-off stops being a visible swap. See `animate-blur-in`.
          loaded && !instant && "motion-safe:animate-blur-in",
        )}
      />
    </div>
  );
}
