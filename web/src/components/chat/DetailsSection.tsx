import type { ReactNode } from "react";

// A labelled, staggered-in block: an icon + heading + one-line explanation,
// then its controls. The explanation is what makes the group settings modal
// and the chat details panel self-explanatory rather than a wall of mystery
// icons.
//
// It's a size container, so what's inside can lay itself out by the width it
// actually gets (`@sm:` etc.) — the same section is a roomy modal on a phone
// and a narrow side panel on a desktop (issue #563).
export function DetailsSection({
  index,
  icon,
  title,
  description,
  children,
}: {
  index: number;
  icon: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      className="@container flex flex-col gap-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          {icon}
        </div>
        <div className="flex flex-col">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}
