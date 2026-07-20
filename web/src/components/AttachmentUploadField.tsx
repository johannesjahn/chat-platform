import { useRef, useState } from "react";
import { Loader2, Paperclip, X } from "lucide-react";
import { AttachmentPreview } from "@/components/AttachmentPreview";
import { Button } from "@/components/ui/button";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_SIZE_BYTES,
  formatBytes,
  isAllowedAttachmentFile,
  uploadAttachment,
  type Attachment,
  type AttachmentUpload,
} from "@/lib/attachments";
import { cn } from "@/lib/utils";

type AttachmentUploadFieldProps = {
  // The already-uploaded attachment for this draft, if any — `null` before
  // a file is picked/dropped and after `onClear`.
  attachment: Attachment | null;
  onUploaded: (attachment: Attachment) => void;
  onClear: () => void;
  disabled?: boolean;
  className?: string;
};

// Drag-and-drop (plus click-to-browse) file picker with an upload progress
// bar (issue #221) — shared by ChatComposer and PostForm. Uploads
// immediately on drop/selection (rather than waiting for the surrounding
// form's submit) so the message/post composer already has a real
// `attachmentId` by the time the user hits send.
export function AttachmentUploadField({
  attachment,
  onUploaded,
  onClear,
  disabled = false,
  className,
}: AttachmentUploadFieldProps) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pendingFilename, setPendingFilename] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const uploadRef = useRef<AttachmentUpload | null>(null);

  function startUpload(file: File) {
    setError(null);
    if (!isAllowedAttachmentFile(file)) {
      setError(`Unsupported file type: ${file.type || "unknown"}`);
      return;
    }
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      setError(
        `File exceeds the ${formatBytes(MAX_ATTACHMENT_SIZE_BYTES)} limit`,
      );
      return;
    }
    setUploading(true);
    setProgress(0);
    setPendingFilename(file.name);
    const upload = uploadAttachment(file, setProgress);
    uploadRef.current = upload;
    upload.promise
      .then((result) => {
        onUploaded(result);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Upload failed");
      })
      .finally(() => {
        setUploading(false);
        uploadRef.current = null;
      });
  }

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (file) startUpload(file);
  }

  function cancelUpload() {
    uploadRef.current?.abort();
    uploadRef.current = null;
    setUploading(false);
    setPendingFilename(null);
  }

  if (attachment) {
    return (
      <div className={cn("relative", className)}>
        <AttachmentPreview attachment={attachment} />
        <Button
          type="button"
          size="icon"
          variant="secondary"
          aria-label="Remove attachment"
          disabled={disabled}
          onClick={onClear}
          className="absolute top-2 right-2 size-7 shadow"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }

  if (uploading) {
    return (
      <div
        className={cn(
          "flex flex-col gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5",
          className,
        )}
      >
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          <span className="flex-1 truncate">{pendingFilename}</span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Cancel upload"
            onClick={cancelUpload}
            className="size-6"
          >
            <X className="size-3.5" />
          </Button>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-150"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex w-full flex-col items-center gap-1.5 rounded-lg border-2 border-dashed border-border px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted/40",
          dragOver && "border-primary bg-primary/5",
        )}
      >
        <Paperclip className="size-5" />
        <span>Drag & drop a file, or click to browse</span>
        <span className="text-xs">
          Images, video, or audio — up to{" "}
          {formatBytes(MAX_ATTACHMENT_SIZE_BYTES)}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_ATTACHMENT_MIME_TYPES.join(",")}
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  );
}
