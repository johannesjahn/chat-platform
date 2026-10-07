// The unread count pinned to a sidebar icon's corner — the same pill and pop
// the phone bar's badges use, re-keyed on the count so it replays.
export function SidebarBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      key={count}
      aria-hidden
      className="absolute -right-2 -top-1.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground motion-safe:animate-badge-pop"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
