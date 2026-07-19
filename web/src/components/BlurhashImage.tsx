import { decode } from "blurhash";
import { useEffect, useRef, useState } from "react";
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
// Keyed by `src` internally (see the wrapper below) so `Inner`'s `loaded`
// state always starts fresh for a new image instead of needing an effect to
// reset it on prop change.
export function BlurhashImage(props: BlurhashImageProps) {
  return <BlurhashImageInner key={props.src} {...props} />;
}

function BlurhashImageInner({
  src,
  alt,
  width,
  height,
  blurhash,
  className,
}: BlurhashImageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);

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
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-300",
            loaded ? "opacity-0" : "opacity-100",
          )}
        />
      )}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        className={cn(
          "absolute inset-0 h-full w-full object-cover transition-opacity duration-300",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}
