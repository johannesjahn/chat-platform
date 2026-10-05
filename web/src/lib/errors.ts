// Errors may be a thrown Error (network) or the API's typed error body ({ message }).
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    // `HttpApiDecodeError`'s top-level `message` is a raw, multi-line,
    // tree-formatted parse trace (see ParseResult.TreeFormatter) — not
    // meant for an end user. `issues` is the structured per-field
    // breakdown instead (ParseResult.ArrayFormatter): each entry's own
    // `message` is the specific, human-readable string a failed
    // `Schema.filter`/`Schema.pattern`/etc. refinement supplied, so prefer
    // those over the tree dump.
    if (
      "_tag" in err &&
      (err as { _tag: unknown })._tag === "HttpApiDecodeError" &&
      "issues" in err &&
      Array.isArray((err as { issues: unknown }).issues)
    ) {
      const issueMessages = (err as { issues: unknown[] }).issues
        .map((issue) =>
          typeof issue === "object" &&
          issue !== null &&
          "message" in issue &&
          typeof (issue as { message: unknown }).message === "string"
            ? (issue as { message: string }).message
            : undefined,
        )
        .filter((message): message is string => message !== undefined);
      if (issueMessages.length > 0) return issueMessages.join("; ");
    }
    if (
      "message" in err &&
      typeof (err as { message: unknown }).message === "string"
    ) {
      return (err as { message: string }).message;
    }
  }
  return "Something failed";
}

// Whether a read query failed because the thing it asked for isn't there:
// the API's `NotFound` (deleted, never existed, or hidden from this reader),
// or an id in the URL that doesn't even parse (`HttpApiDecodeError` on a
// path param). Pages show a "not found" state for these rather than the raw
// error text, which they keep for real failures (network, 5xx).
export function isNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || err instanceof Error)
    return false;
  const tag = (err as { _tag?: unknown })._tag;
  return tag === "NotFound" || tag === "HttpApiDecodeError";
}
