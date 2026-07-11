// Mirrors `ALLOWED_IMAGE_HOST_DOMAINS`/`isAllowedImageUrl` in src/Api.ts so
// the composer/post form can reject a bad `image_url` before round-tripping
// to the server (issue #47). The server is the source of truth — this is
// purely for immediate UI feedback and must be kept in sync by hand.
export const ALLOWED_IMAGE_HOST_DOMAINS = [
  "picsum.photos",
  "imgur.com",
  "unsplash.com",
  "gravatar.com",
  "githubusercontent.com",
  "imgbb.com",
  "ibb.co",
  "cloudinary.com",
  "googleusercontent.com",
  "discordapp.com",
  "discordapp.net",
  "staticflickr.com",
  "wikimedia.org",
  "pexels.com",
  "pixabay.com",
] as const;

const isAllowedImageHost = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  return ALLOWED_IMAGE_HOST_DOMAINS.some(
    (domain) => lower === domain || lower.endsWith(`.${domain}`),
  );
};

export function isAllowedImageUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && isAllowedImageHost(url.hostname);
}
