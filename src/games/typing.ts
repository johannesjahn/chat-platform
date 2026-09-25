import type { GameRules } from "./rules.ts";

// The typing race's passage bank. Plain ASCII only — no curly quotes, em
// dashes, or accented letters — so every passage is typeable as-is on any
// keyboard layout without an IME or compose key. Each is a few sentences,
// long enough that a race lasts roughly 30-60 seconds at typical speeds.
export const TYPING_PASSAGES: ReadonlyArray<string> = [
  "The lighthouse keeper wound the great clock every evening at dusk. Ships he would never meet depended on that small ritual, and he found a quiet kind of pride in being trusted by strangers.",
  "Good software is rarely written in one sitting. It is sketched, argued over, rewritten, and trimmed until what remains feels obvious, as if it could never have been any other way.",
  "Rain drummed on the tin roof of the old market while vendors pulled their awnings tight. Nobody hurried home; the smell of roasted chestnuts was reason enough to stay a little longer.",
  "A good map does not show everything. It leaves out the noise so the road you need stands out, which is exactly what a good explanation does for a hard idea.",
  "The orchestra tuned in a slow swell of sound, every instrument searching for the same note. Then the hall went silent, the conductor lifted her hands, and the first chord filled the room.",
  "Astronomers once measured the distance to nearby stars by watching them shift against the background as the Earth swung around the Sun. Patience, it turns out, is a precise instrument.",
  "The best way to learn a new city is to get a little lost in it. Take the side street, follow the smell of fresh bread, and let the plan you made this morning quietly fall apart.",
  "Every bridge is a promise that the weight on one side will be carried safely to the other. Engineers spend years making sure that promise is kept without anyone ever noticing.",
  "She planted the tomatoes in late spring, talked to them most mornings, and was only a little embarrassed when the neighbors caught her doing it. The harvest that summer was the best in years.",
  "A quick brown fox jumps over the lazy dog, which is a fine sentence for testing keyboards but a poor one for describing the fox, who was mostly just trying to get home before dark.",
  "Bread asks for very little: flour, water, salt, and time. The time is the hard part. Rushing the dough gives you something edible, but waiting gives you something worth sharing.",
  "The chess club met on Thursdays in the back of the library. Most games ended in friendly arguments about what might have happened if someone had only moved the knight instead.",
  "Mountain weather changes faster than any forecast. Experienced hikers pack for three seasons, turn back without shame, and know that the summit will still be there next year.",
  "Before the printing press, a single book could take a scribe many months to copy. Today a thought can cross the planet in less time than it takes to read this sentence aloud.",
  "The train pulled out of the station just as the sun came up, painting the fields in long gold stripes. Somewhere in the third carriage a child pressed her nose to the glass and waved.",
  "Debugging is like being the detective in a crime story where you are also the murderer. The clues were all left by you, and somehow that makes them harder to read, not easier.",
  "Coral reefs cover a tiny fraction of the ocean floor yet shelter a quarter of all marine species. They are cities built over centuries by creatures smaller than a grain of rice.",
  "The old radio crackled to life with a song nobody in the kitchen had heard in years. Within a minute everyone was singing along, getting half the words wrong and not caring at all.",
  "Practice does not make perfect; it makes permanent. The habits you repeat are the ones you keep, so it pays to practice slowly and correctly before you ever try to go fast.",
  "Owls can turn their heads almost all the way around because their eyes cannot move in their sockets. Nature solved the problem of looking sideways by rebuilding the entire neck.",
  "The team shipped the release late on Friday, which everyone agreed was a terrible idea. By Monday morning nothing had broken, and they agreed it had been a terrible idea anyway.",
  "Snow fell all night, softening every edge in the town. By morning the streets were silent, the cars were white hills, and the only tracks in the park belonged to a very busy rabbit.",
  "A compass does not tell you where to go. It only tells you which way is north, and trusts you to work out the rest. Most good advice works in exactly the same way.",
  "The museum guard had walked past the same painting ten thousand times. One afternoon he finally stopped, looked closely, and noticed a tiny dog hiding in the corner of the crowd.",
];

// A race has to be long enough to mean something and short enough that one
// abandoned tab can't hold a lobby hostage.
export const TYPING_COUNTDOWN_MS = 4_000;
export const TYPING_TIME_LIMIT_MS = 180_000;

// Well past the fastest sustained typing ever recorded — a finish faster
// than this wasn't typed, it was pasted or scripted, and is rejected rather
// than recorded on the leaderboard.
export const MAX_PLAUSIBLE_WPM = 250;

// Standard WPM convention: a "word" is five characters, spaces and
// punctuation included, so the number is comparable across passages.
const CHARS_PER_WORD = 5;

const round1 = (value: number) => Math.round(value * 10) / 10;

export const typingRules: GameRules = {
  countdownMs: TYPING_COUNTDOWN_MS,
  timeLimitMs: TYPING_TIME_LIMIT_MS,
  // Never the passage just raced, so a rematch always feels fresh.
  pickPassage: (previous) => {
    const pool = TYPING_PASSAGES.filter((passage) => passage !== previous);
    return pool[Math.floor(Math.random() * pool.length)]!;
  },
  score: ({ passage, typed, errors, durationMs }) => {
    if (typed !== passage) {
      return { ok: false, reason: "Typed text does not match the passage" };
    }
    const minutes = Math.max(durationMs, 1) / 60_000;
    const wpm = passage.length / CHARS_PER_WORD / minutes;
    if (wpm > MAX_PLAUSIBLE_WPM) {
      return { ok: false, reason: "Finish time is not plausible" };
    }
    // Every character had to be typed correctly once to finish; each wrong
    // keystroke along the way is one extra attempt.
    const accuracy = (passage.length / (passage.length + errors)) * 100;
    return { ok: true, score: round1(wpm), accuracy: round1(accuracy) };
  },
};
