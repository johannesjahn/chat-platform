import { API_URL } from "./api";
import { getSession } from "./auth";
import type { components } from "./api-types";

export type User = components["schemas"]["User"];

// Mirrors ALLOWED_AVATAR_MIME_TYPES/MAX_AVATAR_UPLOAD_SIZE_BYTES in
// src/Api.ts and MIN_AVATAR_SOURCE_PX in src/ImageProcessing.ts — kept in
// sync here so the picker/crop dialog can reject a bad file before spending
// a round trip on it, the same way lib/attachments.ts does for attachments.
export const ALLOWED_AVATAR_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const MAX_AVATAR_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;

export const MIN_AVATAR_SOURCE_PX = 256;

export function isAllowedAvatarFile(file: File): boolean {
  return (ALLOWED_AVATAR_MIME_TYPES as readonly string[]).includes(file.type);
}

export class AvatarUploadError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type AvatarCropRegion = {
  x: number;
  y: number;
  size: number;
};

// Posts a real `multipart/form-data` body to `POST /users/me/avatar` (the
// crop rectangle as plain form fields alongside the file) — mirrors
// `uploadAttachment` in lib/attachments.ts, minus the upload-progress
// plumbing that needs XMLHttpRequest: avatars are capped at
// MAX_AVATAR_UPLOAD_SIZE_BYTES (far smaller than an attachment) and
// resolve quickly enough that a progress bar isn't worth the complexity.
export async function uploadAvatar(
  file: File,
  crop: AvatarCropRegion,
): Promise<User> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("x", String(crop.x));
  form.append("y", String(crop.y));
  form.append("size", String(crop.size));

  const session = getSession();
  const response = await fetch(`${API_URL}/users/me/avatar`, {
    method: "POST",
    headers: session
      ? { Authorization: `Bearer ${session.accessToken}` }
      : undefined,
    body: form,
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // ignore — surfaced as a generic status-code error below
  }
  if (!response.ok) {
    const message =
      (body as { message?: string } | null)?.message ??
      `Upload failed (${response.status})`;
    throw new AvatarUploadError(message, response.status);
  }
  return body as User;
}
