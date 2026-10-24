import { API_URL, sendWithSession } from "./api";
import type { components } from "./api-types";

export type Attachment = components["schemas"]["Attachment"];

// Mirrors ALLOWED_ATTACHMENT_MIME_TYPES/MAX_ATTACHMENT_SIZE_BYTES in
// src/Api.ts — kept in sync here so the picker can reject an unsupported
// file/oversized file before spending a round trip on it, the same way
// PostForm/ChatComposer already validate image URLs and content length
// client-side.
//
// PDF uploads are disabled: `application/pdf` intentionally isn't listed
// here. `attachmentKind` below still recognizes "pdf" so attachments
// uploaded before this change keep rendering via AttachmentPreview.
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  // Recorded voice messages (VoiceRecorderField.tsx) — Chrome/Firefox's
  // MediaRecorder defaults to audio/webm;codecs=opus, Safari to audio/mp4.
  "audio/webm",
  "audio/mp4",
] as const;

export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

export function isAllowedAttachmentFile(file: File): boolean {
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(
    file.type,
  );
}

export type AttachmentKind = "image" | "video" | "audio" | "pdf" | "file";

export function attachmentKind(mimeType: string): AttachmentKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";
  return "file";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

export class AttachmentUploadError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type AttachmentUpload = {
  promise: Promise<Attachment>;
  abort: () => void;
};

// Uses XMLHttpRequest rather than `fetchClient`/openapi-fetch (which the
// rest of the app uses) because it's the only browser API that exposes
// upload progress events — needed for the composer's progress bar. This
// posts a real `multipart/form-data` body, matching the shape
// `POST /attachments` expects (see src/AttachmentsHandler.ts). It goes
// through `sendWithSession`, so an expired access token is refreshed first
// and a 401 `Unauthorized` is refreshed and re-sent with the same file —
// the middleware that does this for `fetchClient` can't see an XHR
// (issue #685).
export function uploadAttachment(
  file: File,
  onProgress?: (fraction: number) => void,
): AttachmentUpload {
  let current: XMLHttpRequest | null = null;
  let aborted = false;
  const cancelled = () => new AttachmentUploadError("Upload cancelled", 0);

  const send = (accessToken: string | null) =>
    new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      // Aborted while the token was being refreshed — never send.
      if (aborted) return reject(cancelled());
      const xhr = new XMLHttpRequest();
      current = xhr;
      xhr.open("POST", `${API_URL}/attachments`);
      if (accessToken) {
        xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
      }
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded / event.total);
      };
      xhr.onload = () => {
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // ignore — surfaced as a generic status-code error below
        }
        resolve({ status: xhr.status, body });
      };
      xhr.onerror = () =>
        reject(new AttachmentUploadError("Network error during upload", 0));
      xhr.onabort = () => reject(cancelled());

      const form = new FormData();
      form.append("file", file, file.name);
      xhr.send(form);
    });

  const promise = sendWithSession(send).then(({ status, body }) => {
    if (status >= 200 && status < 300) return body as Attachment;
    const message =
      (body as { message?: string } | null)?.message ??
      `Upload failed (${status})`;
    throw new AttachmentUploadError(message, status);
  });
  return {
    promise,
    abort: () => {
      aborted = true;
      current?.abort();
    },
  };
}
