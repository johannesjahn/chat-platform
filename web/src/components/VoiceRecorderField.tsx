import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square, X } from "lucide-react";
import { AttachmentPreview } from "@/components/AttachmentPreview";
import { Button } from "@/components/ui/button";
import {
  uploadAttachment,
  type Attachment,
  type AttachmentUpload,
} from "@/lib/attachments";
import { cn } from "@/lib/utils";

type VoiceRecorderFieldProps = {
  // The already-uploaded voice recording for this draft, if any — mirrors
  // AttachmentUploadField's `attachment` prop so ChatComposer can treat a
  // voice message as just another flavor of "attachment" content type.
  attachment: Attachment | null;
  onUploaded: (attachment: Attachment) => void;
  onClear: () => void;
  disabled?: boolean;
  className?: string;
};

// Auto-stops (and uploads) a recording still running at this length, so a
// forgotten open mic can't grow into an upload that blows past
// MAX_ATTACHMENT_SIZE_BYTES — at typical MediaRecorder Opus bitrates this
// caps well under the 25MB limit with headroom to spare.
const MAX_RECORDING_MS = 5 * 60 * 1000;

// Preference order for the container MediaRecorder should encode into.
// Chrome/Firefox support webm/ogg Opus; Safari (WebKit) only speaks mp4/AAC.
// All three are in ALLOWED_ATTACHMENT_MIME_TYPES (src/Api.ts) and decode
// fine through the server's ffmpeg-based processAudio() regardless of which
// one a given browser picks.
const RECORDING_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm",
];

function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return RECORDING_MIME_CANDIDATES.find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

// MediaRecorder's mimeType carries a codec param (e.g.
// "audio/webm;codecs=opus") that ALLOWED_ATTACHMENT_MIME_TYPES doesn't
// include — strip it down to the bare container type the upload endpoint
// checks against.
function bareContentType(recorderMimeType: string): string {
  return recorderMimeType.split(";")[0]!;
}

function extensionForContentType(contentType: string): string {
  if (contentType === "audio/mp4") return "m4a";
  if (contentType === "audio/ogg") return "ogg";
  return "webm";
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const canRecord =
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== "undefined";

// Tap-to-record voice message field (mirrors AttachmentUploadField's
// immediate-upload pattern): records from the mic via MediaRecorder, then
// uploads the resulting clip through the same `POST /attachments` endpoint
// as a picked file the moment recording stops.
export function VoiceRecorderField({
  attachment,
  onUploaded,
  onClear,
  disabled = false,
  className,
}: VoiceRecorderFieldProps) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uploadRef = useRef<AttachmentUpload | null>(null);

  // Guards against an open mic surviving a composer/route unmount mid
  // recording.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      // Only an actively recording recorder can be stopped — calling stop()
      // on one that's already inactive (the common case here: a clip was
      // recorded, then the composer unmounts on navigation) throws
      // InvalidStateError, which would surface as an uncaught error in this
      // cleanup.
      if (recorderRef.current?.state !== "inactive")
        recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      uploadRef.current?.abort();
    };
  }, []);

  function stopStream() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function startUpload(blob: Blob, recorderMimeType: string) {
    const contentType = bareContentType(recorderMimeType);
    const file = new File(
      [blob],
      `voice-message.${extensionForContentType(contentType)}`,
      { type: contentType },
    );
    setUploading(true);
    setProgress(0);
    const upload = uploadAttachment(file, setProgress);
    uploadRef.current = upload;
    upload.promise
      .then((result) => onUploaded(result))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Upload failed");
      })
      .finally(() => {
        setUploading(false);
        uploadRef.current = null;
      });
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      streamRef.current = stream;
      const mimeType = pickRecorderMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      chunksRef.current = [];
      discardRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const discarded = discardRef.current;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];
        if (!discarded && blob.size > 0) startUpload(blob, recorder.mimeType);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);

      const startedAt = Date.now();
      setElapsedMs(0);
      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        setElapsedMs(elapsed);
        if (elapsed >= MAX_RECORDING_MS) finishRecording();
      }, 250);
    } catch {
      setError("Microphone access was denied or is unavailable.");
    }
  }

  function finishRecording() {
    discardRef.current = false;
    recorderRef.current?.stop();
    stopStream();
    setRecording(false);
  }

  function cancelRecording() {
    discardRef.current = true;
    recorderRef.current?.stop();
    stopStream();
    setRecording(false);
  }

  function cancelUpload() {
    uploadRef.current?.abort();
    uploadRef.current = null;
    setUploading(false);
  }

  if (attachment) {
    // A recorded clip is always audio — AudioPlayer's pill already fills the
    // row edge to edge, so (unlike AttachmentUploadField's image/video/pdf
    // cases, which have empty corners to float a button over) the remove
    // control sits beside it rather than overlaid on top.
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <AttachmentPreview attachment={attachment} className="min-w-0 flex-1" />
        <Button
          type="button"
          size="icon"
          variant="secondary"
          aria-label="Remove voice message"
          disabled={disabled}
          onClick={onClear}
          className="size-8 shrink-0 shadow"
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
          <span className="flex-1 truncate">Uploading voice message…</span>
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
            className="h-full rounded-full bg-primary transition-[width] duration-150 motion-safe:animate-progress-stripes"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>
    );
  }

  if (recording) {
    return (
      <div
        className={cn(
          // A slow red breath around the whole row, so an open microphone is
          // obvious at a glance rather than only through the 10px dot below.
          "flex items-center gap-2 rounded-lg border border-destructive/40 bg-muted/40 px-3 py-2 motion-safe:animate-record-pulse",
          className,
        )}
      >
        <span className="relative flex size-2.5 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive/60 motion-reduce:hidden" />
          <span className="relative inline-flex size-2.5 rounded-full bg-destructive" />
        </span>
        <span className="flex-1 tabular-nums text-sm text-muted-foreground">
          {formatDuration(elapsedMs)}
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Cancel recording"
          onClick={cancelRecording}
          className="size-7"
        >
          <X className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="secondary"
          aria-label="Stop recording"
          onClick={finishRecording}
          className="size-7"
        >
          <Square className="size-3.5 fill-current" />
        </Button>
      </div>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        disabled={disabled || !canRecord}
        onClick={() => void startRecording()}
        className="flex w-full flex-col items-center gap-1.5 rounded-lg border-2 border-dashed border-border px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted/40 disabled:pointer-events-none disabled:opacity-50"
      >
        <Mic className="size-5" />
        <span>
          {canRecord
            ? "Tap to record a voice message"
            : "Voice recording isn't supported in this browser"}
        </span>
      </button>
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  );
}
