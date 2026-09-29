// Prompt dealing and the title comparisons behind "Too close to the truth"
// and duplicate-bluff rejection. Pure functions; the randomness source is
// injectable so tests can pin a deal down.

export type RandomInt = (maxExclusive: number) => number;

// Unbiased and unpredictable: a deal is secret information, so it shouldn't
// come from a PRNG whose state could in principle be reconstructed.
export const secureRandomInt: RandomInt = (maxExclusive) => {
  if (maxExclusive <= 1) return 0;
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0]! < limit) return buffer[0]! % maxExclusive;
  }
};

// Fisher-Yates over a copy.
export const shuffled = <T>(
  items: ReadonlyArray<T>,
  randomInt: RandomInt,
): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

// `count` distinct prompts from `pool`, preferring ones not in `avoid` (the
// previous game's, so a rematch feels fresh) and falling back to them only
// if the pool is too small otherwise. Null if even that isn't enough.
export const dealPrompts = (
  pool: ReadonlyArray<string>,
  count: number,
  avoid: ReadonlyArray<string>,
  randomInt: RandomInt = secureRandomInt,
): string[] | null => {
  const distinct = [...new Set(pool)];
  if (distinct.length < count) return null;
  const avoided = new Set(avoid);
  const fresh = shuffled(
    distinct.filter((prompt) => !avoided.has(prompt)),
    randomInt,
  );
  const stale = shuffled(
    distinct.filter((prompt) => avoided.has(prompt)),
    randomInt,
  );
  return [...fresh, ...stale].slice(0, count);
};

const ARTICLES = new Set(["a", "an", "the"]);

// Folds a title down to what a reader would call "the same words": case,
// accents, punctuation, runs of whitespace, and leading articles don't
// count. Used both for comparing a bluff with the real prompt and for
// spotting two identical bluffs.
export const normalizeTitle = (text: string): string => {
  const words = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
  while (words.length > 1 && ARTICLES.has(words[0]!)) words.shift();
  return words.join(" ");
};

// Classic two-row Levenshtein distance.
export const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + substitution,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
};

// A crude plural fold ("cats" → "cat"), only for longer words so "bus" and
// "gas" survive. Good enough to catch the obvious near-copies.
const stem = (word: string) =>
  word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
    ? word.slice(0, -1)
    : word;

// The words regardless of order, articles, or plurals.
const bagOfWords = (normalized: string) =>
  normalized
    .split(" ")
    .filter((word) => !ARTICLES.has(word))
    .map(stem)
    .sort()
    .join(" ");

// Would this bluff give the answer away? True when it's the prompt give or
// take case, punctuation, articles, plurals, word order, or a typo or two —
// roughly one edit per eight letters.
export const isTooCloseToPrompt = (bluff: string, prompt: string): boolean => {
  const a = normalizeTitle(bluff);
  const b = normalizeTitle(prompt);
  if (a === b) return true;
  if (bagOfWords(a) === bagOfWords(b)) return true;
  const longest = Math.max(a.length, b.length);
  const tolerance = longest < 6 ? 0 : Math.max(1, Math.floor(longest / 8));
  return (
    editDistance(a.replaceAll(" ", ""), b.replaceAll(" ", "")) <= tolerance
  );
};
