import { Paperclip } from "lucide-react";

// What the conversation shows while a file is dragged over it.
export function DropOverlay() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-background/85 text-sm font-medium text-foreground backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-200"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/15 text-primary">
        <Paperclip className="size-5" />
      </span>
      Drop to attach
    </div>
  );
}
