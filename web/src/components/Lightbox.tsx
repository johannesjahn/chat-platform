import { useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

type LightboxProps = {
  src: string;
  alt: string;
  onClose: () => void;
};

// Full-screen image viewer (issue #320). Feed image posts and image
// attachments render cropped/thumbnailed in place; clicking one opens it
// here at full size — contained (never cropped) against a dimmed backdrop,
// dismissed by the close button, a backdrop click, or `Esc`. Follows the
// same modal chrome as AvatarCropDialog/GroupManagementDialog (fixed
// overlay, Escape-to-close, background scroll lock) rather than pulling in a
// lightbox dependency.
export function Lightbox({ src, alt, onClose }: LightboxProps) {
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Image"}
    >
      <div
        className="absolute inset-0 bg-background/85 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
        onClick={onClose}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute top-4 right-4 z-10 rounded-full bg-background/60 hover:bg-background/80"
        onClick={onClose}
        aria-label="Close image"
      >
        <X className="size-5" />
      </Button>
      <img
        src={src}
        alt={alt}
        className="relative max-h-full max-w-full rounded-lg object-contain shadow-2xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-300"
      />
    </div>
  );
}
