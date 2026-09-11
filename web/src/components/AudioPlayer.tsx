import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pause, Play } from "lucide-react";
import {
  WAVEFORM_BAR_COUNT,
  decodeWaveform,
  flatWaveform,
  resampleWaveform,
} from "@/lib/waveform";
import { cn } from "@/lib/utils";

type AudioPlayerProps = {
  src: string;
  // Amplitude levels (0..100) measured server-side at upload time, and the
  // clip's length — see `waveform`/`durationMs` on Attachment. Null for
  // audio uploaded before the server started measuring them, in which case
  // the player decodes the clip itself the first time it's played.
  waveform?: ReadonlyArray<number> | null;
  durationMs?: number | null;
  className?: string;
};

// Drawn as the played portion of a bar / the rest of it. `currentColor` so
// the row picks up whatever text color its bubble sets, the way the rest of
// the pill's border and background already do.
const PLAYED_FILL = "currentColor";
const UNPLAYED_FILL = "color-mix(in oklab, currentColor 28%, transparent)";

// A bar is filled left-to-right by the playhead rather than flipping whole,
// so progress reads continuously instead of stepping a bar at a time.
function barFill(fraction: number): string {
  if (fraction <= 0) return UNPLAYED_FILL;
  if (fraction >= 1) return PLAYED_FILL;
  const stop = `${(fraction * 100).toFixed(2)}%`;
  return `linear-gradient(to right, ${PLAYED_FILL} ${stop}, ${UNPLAYED_FILL} ${stop})`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

// A compact, waveform-style player used anywhere an audio attachment (a
// voice message or an uploaded audio file — AttachmentPreview doesn't
// distinguish the two) renders inline, replacing the browser's native
// `<audio controls>` chrome with something that matches the app's rounded,
// primary-accented, spring-eased visual language.
//
// The bars are the clip's actual amplitude envelope, so a voice message
// looks like speech (pauses included) and a track looks like the track.
export function AudioPlayer({
  src,
  waveform,
  durationMs,
  className,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const barsRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  // What the <audio> element reports once it has metadata. Kept separate
  // from the server-measured `durationMs` below so the element's own
  // (authoritative, seekable) value wins as soon as it exists: Ogg/Opus
  // served over a presigned URL often reports Infinity or NaN until then,
  // which is exactly the window the stored duration covers.
  const [loadedDuration, setLoadedDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  // Levels recovered in-browser for a clip that has none stored. Tagged
  // with the clip they were decoded from, so a player that gets pointed at
  // a different `src` (a recycled bubble, a re-minted presigned URL) falls
  // back to the flat row instead of briefly drawing the old clip's shape.
  const [decoded, setDecoded] = useState<{
    src: string;
    levels: number[];
  } | null>(null);
  const decodedWaveform = decoded?.src === src ? decoded.levels : null;

  const duration =
    loadedDuration > 0
      ? loadedDuration
      : durationMs && durationMs > 0
        ? durationMs / 1000
        : 0;

  const levels = waveform ?? decodedWaveform;
  const bars = useMemo(
    () => (levels ? resampleWaveform(levels) : flatWaveform()),
    [levels],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onLoaded = () =>
      setLoadedDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onEnd = () => setPlaying(false);
    const onPause = () => setPlaying(false);
    const onPlay = () => setPlaying(true);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("ended", onEnd);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("play", onPlay);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("ended", onEnd);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("play", onPlay);
    };
  }, []);

  // `timeupdate` only fires a handful of times a second, which is plenty
  // for the elapsed-time label but visibly steps the playhead across the
  // bars. While playing, follow the clock on an animation frame instead —
  // capped at ~30 updates a second, since each one restyles every bar and
  // nothing about a moving playhead needs more than that.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let lastUpdate = 0;
    const tick = (now: number) => {
      const audio = audioRef.current;
      if (audio && now - lastUpdate >= 33) {
        lastUpdate = now;
        setCurrentTime(audio.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // Recovering a waveform costs a second download of the clip, so it waits
  // for a deliberate play rather than happening for every audio attachment
  // that scrolls past. Clips uploaded after the server-side pass never get
  // here at all.
  useEffect(() => {
    if (waveform || decodedWaveform || !playing) return;
    const controller = new AbortController();
    void decodeWaveform(src, WAVEFORM_BAR_COUNT, controller.signal).then(
      (levels) => {
        if (!controller.signal.aborted && levels) setDecoded({ src, levels });
      },
    );
    return () => controller.abort();
  }, [src, waveform, decodedWaveform, playing]);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }

  function seekToClientX(clientX: number) {
    const audio = audioRef.current;
    const bars = barsRef.current;
    if (!audio || !bars || !duration) return;
    const rect = bars.getBoundingClientRect();
    const fraction = Math.min(
      1,
      Math.max(0, (clientX - rect.left) / rect.width),
    );
    audio.currentTime = fraction * duration;
    setCurrentTime(audio.currentTime);
  }

  // Pointer capture turns the bars into a scrubber: press anywhere on the
  // row and drag, and playback follows the finger/cursor even once it
  // leaves the (fairly short) row.
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    seekToClientX(event.clientX);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    seekToClientX(event.clientX);
  }

  function seekBy(deltaSeconds: number) {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const next = Math.min(
      duration,
      Math.max(0, audio.currentTime + deltaSeconds),
    );
    audio.currentTime = next;
    setCurrentTime(next);
  }

  function onBarsKeyDown(event: KeyboardEvent) {
    if (!duration) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      seekBy(5);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekBy(-5);
    } else if (event.key === "Home") {
      event.preventDefault();
      seekBy(-duration);
    } else if (event.key === "End") {
      event.preventDefault();
      seekBy(duration);
    }
  }

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const elapsed = currentTime > 0 || playing;

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-full border border-current/10 bg-current/5 py-2 pr-3.5 pl-2",
        className,
      )}
    >
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? "Pause" : "Play"}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm shadow-primary/25 transition-all duration-200 ease-spring hover:scale-105 hover:shadow-md hover:shadow-primary/35 active:scale-95"
      >
        {playing ? (
          <Pause className="size-4 fill-current" />
        ) : (
          <Play className="size-4 translate-x-0.5 fill-current" />
        )}
      </button>

      <div
        ref={barsRef}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.floor(duration)}
        aria-valuenow={Math.floor(currentTime)}
        aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onBarsKeyDown}
        className="flex h-8 min-w-0 flex-1 cursor-pointer touch-none items-center gap-[2px] rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-current/40"
      >
        {bars.map((level, i) => (
          <span
            key={i}
            style={{
              height: `${level}%`,
              minHeight: "2px",
              background: barFill(progress * bars.length - i),
            }}
            className="min-w-px flex-1 rounded-full"
          />
        ))}
      </div>

      <span className="shrink-0 text-xs tabular-nums text-current/70">
        {formatTime(elapsed ? currentTime : duration)}
      </span>
    </div>
  );
}
