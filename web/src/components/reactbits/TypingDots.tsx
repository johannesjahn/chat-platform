import { cn } from "@/lib/utils";

export type TypingDotsProps = {
  className?: string;
};

// Three-dot "someone is typing" indicator, the same wave-bounce chat apps
// (iMessage, WhatsApp, Slack) have used forever — each dot runs the same
// keyframe with a staggered `animation-delay` so they bounce in sequence
// rather than in lockstep.
export function TypingDots({ className }: TypingDotsProps) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 rounded-full bg-current motion-safe:animate-typing-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}
