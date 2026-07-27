import {
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";

type AudioPlayerProps = {
  src: string;
  className?: string;
};

const BAR_COUNT = 40;

// The server stores audio as an opaque file — no decoded amplitude data
// ships with it — so the "waveform" here is a deterministic pseudo-random
// shape derived from the clip's URL (a stable little PRNG, not real
// analysis) rather than an empty/flat placeholder. Same clip always draws
// the same bars across reloads/rerenders.
function waveformHeights(seed: string): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0;
  }
  const heights: number[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    heights.push(0.28 + ((h >>> 8) % 1000) / 1000 / 1.4);
  }
  return heights;
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
export function AudioPlayer({ src, className }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const barsRef = useRef<HTMLButtonElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const heights = useMemo(() => waveformHeights(src), [src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onLoaded = () => setDuration(audio.duration);
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

  // Keyboard-activated clicks (Enter/Space on the focused button) arrive with
  // no pointer coordinates — clientX is 0, which seekToClientX would read as
  // "seek to the very start". Ignore those (detail === 0) and let onKeyDown
  // drive seeking for keyboard users instead.
  function seekFromClick(event: MouseEvent) {
    if (event.detail === 0) return;
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

  const progress = duration > 0 ? currentTime / duration : 0;
  const timeLabel = formatTime(
    currentTime > 0 || playing ? currentTime : duration,
  );

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

      <button
        ref={barsRef}
        type="button"
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.floor(duration)}
        aria-valuenow={Math.floor(currentTime)}
        aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
        onClick={seekFromClick}
        onKeyDown={onBarsKeyDown}
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-end gap-px"
      >
        {heights.map((h, i) => {
          const active = i / BAR_COUNT <= progress;
          return (
            <span
              key={i}
              style={
                playing && active
                  ? { height: `${h * 100}%`, animationDelay: `${i * 45}ms` }
                  : { height: `${h * 100}%` }
              }
              className={cn(
                "min-w-px flex-1 rounded-full transition-colors duration-150",
                active ? "bg-current" : "bg-current/25",
                playing && active && "animate-waveform-bounce",
              )}
            />
          );
        })}
      </button>

      <span className="shrink-0 text-xs tabular-nums text-current/70">
        {timeLabel}
      </span>
    </div>
  );
}
