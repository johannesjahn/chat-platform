// When a body of text — a post, comment or message — is collapsed behind
// "Show more". Characters alone miss a text made of many short lines (40
// one-word lines is well under any character budget but far taller than the
// clamp), so a text also counts as long once it has more lines than the
// clamp shows (issue #898).
export type CollapseRule = {
  // Longer than this many characters…
  maxChars: number;
  // …or more lines than this: the `line-clamp-*` it collapses to.
  maxLines: number;
};

export const POST_COLLAPSE: CollapseRule = { maxChars: 500, maxLines: 6 };
export const COMMENT_COLLAPSE: CollapseRule = { maxChars: 400, maxLines: 6 };
export const MESSAGE_COLLAPSE: CollapseRule = { maxChars: 300, maxLines: 4 };

export function isLongText(
  text: string | null | undefined,
  { maxChars, maxLines }: CollapseRule,
): boolean {
  if (!text) return false;
  if (text.length > maxChars) return true;
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (++lines > maxLines) return true;
  }
  return false;
}
