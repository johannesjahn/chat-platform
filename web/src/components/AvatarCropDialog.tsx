import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import {
  MIN_AVATAR_SOURCE_PX,
  uploadAvatar,
  type AvatarCropRegion,
  type User,
} from "@/lib/avatar";

type NaturalSize = { width: number; height: number };
type Offset = { x: number; y: number };

// The crop viewport is a fixed-size square shown at 1:1 CSS px — simpler
// than making it responsive, and roomy enough on mobile widths (see the
// dialog's own max-width below) to comfortably drag/pinch-equivalent-drag.
const VIEWPORT_PX = 260;

// How far past "the image's shorter side exactly fills the square" (zoom 1,
// the minimum — the image can never be zoomed out further than fitting the
// viewport) the user can zoom in.
const MAX_ZOOM = 3;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

// The smallest either display axis can be at zoom 1 — i.e. the scale factor
// that makes the image's shorter side exactly VIEWPORT_PX.
const minScaleFor = (natural: NaturalSize): number =>
  VIEWPORT_PX / Math.min(natural.width, natural.height);

// Keeps the square viewport always fully covered by the (scaled) image,
// regardless of zoom — panning can never reveal empty space at an edge.
const clampOffset = (
  offset: Offset,
  natural: NaturalSize,
  zoom: number,
): Offset => {
  const scale = minScaleFor(natural) * zoom;
  const displayWidth = natural.width * scale;
  const displayHeight = natural.height * scale;
  return {
    x: clamp(offset.x, VIEWPORT_PX - displayWidth, 0),
    y: clamp(offset.y, VIEWPORT_PX - displayHeight, 0),
  };
};

type AvatarCropDialogProps = {
  file: File;
  onClose: () => void;
  onUploaded: (user: User) => void;
};

// A minimal, dependency-free square-crop UI (issue #269): drag to pan, a
// slider to zoom, with a live circular preview of the final avatar. Lets the
// user pick exactly which square region of an uploaded photo is kept,
// rather than an arbitrary auto-center-crop — the crop rectangle (in the
// original image's pixel coordinates) is computed from the pan/zoom state
// only when confirmed, then sent to `POST /users/me/avatar` alongside the
// original file; the actual cropping/resizing happens server-side
// (ImageProcessing.ts), so nothing is drawn to a canvas here.
export function AvatarCropDialog({
  file,
  onClose,
  onUploaded,
}: AvatarCropDialogProps) {
  // `URL.createObjectURL` is a real side effect (it registers a blob with
  // the document) that has to be paired with exactly one `revokeObjectURL`
  // — it can't live in render (including a `useMemo` factory, which React
  // only promises runs once per commit as a *cache* detail and may
  // legitimately be invoked again with the result discarded, silently
  // leaking a blob that's never revoked) or in a `useState` lazy
  // initializer (doesn't hold up here in practice either, breaking the
  // upload flow — see the AvatarCropDialog test coverage in web/e2e). An
  // effect's mount/cleanup pairing is the one place the guarantee holds.
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above: this isn't deriving state from a prop, it's synchronizing an external resource (a blob) with this component's lifetime.
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const [natural, setNatural] = useState<NaturalSize | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const dragState = useRef<{
    startClientX: number;
    startClientY: number;
    startOffset: Offset;
  } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const size = { width: img.naturalWidth, height: img.naturalHeight };
    setNatural(size);
    setZoom(1);
    const scale = minScaleFor(size);
    setOffset({
      x: (VIEWPORT_PX - size.width * scale) / 2,
      y: (VIEWPORT_PX - size.height * scale) / 2,
    });
  };

  const handleZoomChange = (nextZoom: number) => {
    setZoom(nextZoom);
    if (natural) setOffset((prev) => clampOffset(prev, natural, nextZoom));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!natural) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startOffset: offset,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || !natural) return;
    setOffset(
      clampOffset(
        {
          x: drag.startOffset.x + (e.clientX - drag.startClientX),
          y: drag.startOffset.y + (e.clientY - drag.startClientY),
        },
        natural,
        zoom,
      ),
    );
  };

  const handlePointerUp = () => {
    dragState.current = null;
  };

  const tooSmall =
    natural !== null &&
    (natural.width < MIN_AVATAR_SOURCE_PX ||
      natural.height < MIN_AVATAR_SOURCE_PX);

  const handleConfirm = async () => {
    if (!natural || tooSmall) return;
    setError(null);
    setUploading(true);
    try {
      const scale = minScaleFor(natural) * zoom;
      const size = Math.round(VIEWPORT_PX / scale);
      const crop: AvatarCropRegion = {
        x: clamp(Math.round(-offset.x / scale), 0, natural.width - size),
        y: clamp(Math.round(-offset.y / scale), 0, natural.height - size),
        size,
      };
      const updated = await uploadAvatar(file, crop);
      onUploaded(updated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Crop avatar"
    >
      <div
        className="absolute inset-0 bg-background/70 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
        onClick={onClose}
      />
      <div className="relative flex w-full max-w-sm flex-col gap-4 rounded-3xl border border-border bg-card p-5 shadow-2xl ease-spring motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-300">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Crop your avatar</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onClose}
            aria-label="Cancel"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div
          className="relative mx-auto touch-none overflow-hidden rounded-xl border border-border bg-muted select-none"
          style={{ width: VIEWPORT_PX, height: VIEWPORT_PX }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <img
            src={objectUrl ?? undefined}
            alt=""
            draggable={false}
            onLoad={handleImageLoad}
            className="absolute max-w-none"
            style={
              natural
                ? {
                    left: offset.x,
                    top: offset.y,
                    width: natural.width * minScaleFor(natural) * zoom,
                    height: natural.height * minScaleFor(natural) * zoom,
                  }
                : { opacity: 0 }
            }
          />
          {/* Circular hole via a huge box-shadow spread — previews the
              actual (round) rendered avatar shape without drawing anything
              to a canvas. */}
          <div className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]" />
        </div>

        {tooSmall && natural && (
          <p className="text-center text-sm text-destructive">
            Image is {natural.width}×{natural.height}px — avatars need at least{" "}
            {MIN_AVATAR_SOURCE_PX}×{MIN_AVATAR_SOURCE_PX}px.
          </p>
        )}

        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          disabled={!natural || tooSmall}
          onChange={(e) => handleZoomChange(Number(e.target.value))}
          className="w-full accent-primary"
          aria-label="Zoom"
        />

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={onClose}
            disabled={uploading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="flex-1"
            onClick={handleConfirm}
            disabled={!natural || tooSmall || uploading}
          >
            {uploading && <Loader2 className="size-4 animate-spin" />}
            {uploading ? "Uploading…" : "Save avatar"}
          </Button>
        </div>
      </div>
    </div>
  );
}
