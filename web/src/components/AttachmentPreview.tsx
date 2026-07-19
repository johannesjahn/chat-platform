import { FileText } from "lucide-react";
import { BlurhashImage } from "@/components/BlurhashImage";
import {
  attachmentKind,
  formatBytes,
  type Attachment,
} from "@/lib/attachments";
import { cn } from "@/lib/utils";

type AttachmentPreviewProps = {
  attachment: Attachment;
  className?: string;
};

// Renders an uploaded attachment inline — a preview for the media types
// issue #221 asks for (image/video/audio/pdf), falling back to a plain
// filename/size link for anything else `POST /attachments` happens to
// accept. Used by both MessageBubble and PostCard.
export function AttachmentPreview({
  attachment,
  className,
}: AttachmentPreviewProps) {
  const kind = attachmentKind(attachment.mimeType);

  if (kind === "image") {
    return (
      <BlurhashImage
        src={attachment.url}
        alt={attachment.filename}
        width={attachment.width}
        height={attachment.height}
        blurhash={attachment.blurhash}
        className={cn("max-h-72 w-full rounded-lg", className)}
      />
    );
  }

  if (kind === "video") {
    return (
      <video
        src={attachment.url}
        controls
        preload="metadata"
        className={cn("max-h-72 w-full rounded-lg bg-black", className)}
      />
    );
  }

  if (kind === "audio") {
    return (
      <audio
        src={attachment.url}
        controls
        className={cn("w-full", className)}
      />
    );
  }

  if (kind === "pdf") {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-sm hover:bg-muted",
          className,
        )}
      >
        <FileText className="size-5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate">{attachment.filename}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatBytes(attachment.size)}
        </span>
      </a>
    );
  }

  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      download={attachment.filename}
      className={cn(
        "flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-sm hover:bg-muted",
        className,
      )}
    >
      <FileText className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{attachment.filename}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatBytes(attachment.size)}
      </span>
    </a>
  );
}
