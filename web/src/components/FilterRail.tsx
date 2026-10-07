import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { filterRailRowClassName } from "./filterRailStyles";

export type FilterRailItem<T extends string> = {
  value: T;
  label: string;
  icon: LucideIcon;
  // A count shown at the row's end (results in that section, say). Omitted
  // where there's nothing meaningful to count.
  count?: number;
};

// The desktop pattern for "one of a few views of this page" (issue #554):
// a sticky vertical list beside the content at `lg`+, standing in for the
// tab strip/segmented control the phone layout uses. It only ever renders
// at `lg`+ (`hidden lg:flex`), so a page shows it *alongside* its phone
// control, hiding that one at the same breakpoint, rather than replacing it
// in script.
export function FilterRail<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: ReadonlyArray<FilterRailItem<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "sticky top-6 hidden w-52 shrink-0 flex-col gap-0.5 self-start lg:flex",
        className,
      )}
    >
      {items.map((item) => (
        <FilterRailButton
          key={item.value}
          item={item}
          active={item.value === value}
          onSelect={() => onChange(item.value)}
        />
      ))}
    </div>
  );
}

function FilterRailButton<T extends string>({
  item,
  active,
  onSelect,
}: {
  item: FilterRailItem<T>;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={filterRailRowClassName(active)}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.count !== undefined && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {item.count}
        </span>
      )}
    </button>
  );
}
