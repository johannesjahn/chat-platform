import { cn } from "@/lib/utils";

// One row of the desktop sidebar (issue #554): an icon-only square on the
// `lg` rail, a full-width labelled row once it widens at `xl`. Shared by the
// links, the bell's popover trigger and the search button so every row has
// the same box, hover and focus ring. Active links (TanStack's
// `data-status="active"`, set alongside `aria-current="page"`) get the
// primary tint plus a bar on the leading edge — the "you are here" the top
// bar never had.
export const sidebarItemClassName = cn(
  "relative flex h-11 w-full items-center justify-center gap-3 rounded-xl px-0 text-sm font-medium text-muted-foreground transition-colors xl:justify-start xl:px-3",
  "hover:bg-accent/50 hover:text-foreground",
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  "data-[status=active]:bg-primary/10 data-[status=active]:text-foreground",
  "data-[status=active]:before:absolute data-[status=active]:before:inset-y-2.5 data-[status=active]:before:-left-3 data-[status=active]:before:w-1 data-[status=active]:before:rounded-r-full data-[status=active]:before:bg-primary",
);
