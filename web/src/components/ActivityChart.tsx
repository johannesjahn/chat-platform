import { useId, useState } from "react";
import { cn } from "@/lib/utils";

// A stacked column chart for the admin dashboard's daily timelines, built
// from plain elements rather than an SVG viewBox (and rather than pulling in
// a charting library this dependency-light repo doesn't otherwise need):
// percentage heights inside a flex row are responsive for free, and the hover
// target is a real DOM node per day instead of a hit-testing layer.
//
// Series colours are fixed per series *key*, never assigned by rank, so
// changing the range never repaints a series the reader has already learned.
// They're passed in by the caller (see ACTIVITY_SERIES in routes/admin.tsx)
// and validated as a set against this app's card surface for colour-vision
// separation — don't swap one for an ad-hoc hex.

export type ActivitySeries = {
  readonly key: string;
  readonly label: string;
  /** CSS colour for this series' marks — never used for text. */
  readonly color: string;
};

export type ActivityPoint = {
  /** `YYYY-MM-DD`, UTC — as returned by `GET /admin/stats`. */
  readonly date: string;
  readonly values: Readonly<Record<string, number>>;
};

type ActivityChartProps = {
  points: ReadonlyArray<ActivityPoint>;
  series: ReadonlyArray<ActivitySeries>;
  /** Describes the whole figure for screen readers and the table caption. */
  caption: string;
  className?: string;
};

const formatDay = (date: string): string => {
  // Parsed as UTC (the `YYYY-MM-DD` form is), then formatted in UTC too, so
  // the label always names the same day the bucket counted.
  const parsed = new Date(`${date}T00:00:00Z`);
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
};

// Round the axis ceiling up to the nearest clean number that is *also* even,
// so both the top tick and the midpoint one read as whole numbers (a 25
// ceiling would label its midline 12.5, or 13 if rounded — wrong either way).
// A dense ladder keeps the ceiling close to the tallest bar instead of
// leaving half the plot empty: 27 tops out at 30, not 50.
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

const niceCeiling = (value: number): number => {
  if (value <= 0) return 2;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of NICE_STEPS) {
    const candidate = step * magnitude;
    if (candidate >= value && Number.isInteger(candidate / 2)) return candidate;
  }
  return 20 * magnitude;
};

export function ActivityChart({
  points,
  series,
  caption,
  className,
}: ActivityChartProps) {
  const tableId = useId();
  const [hovered, setHovered] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const totals = points.map((point) =>
    series.reduce((sum, entry) => sum + (point.values[entry.key] ?? 0), 0),
  );
  const ceiling = niceCeiling(Math.max(...totals, 0));
  const grandTotal = totals.reduce((sum, value) => sum + value, 0);

  const firstPoint = points[0];
  const midPoint =
    points.length > 2 ? points[Math.floor((points.length - 1) / 2)] : undefined;
  const lastPoint = points.length > 1 ? points[points.length - 1] : undefined;

  const activeIndex = hovered;
  const active = activeIndex === null ? undefined : points[activeIndex];

  return (
    <figure className={cn("flex w-full flex-col gap-3", className)}>
      {/* `pl-7` is the y-axis gutter the tick labels sit in. */}
      <div className="relative pl-7">
        {/* Gridlines: solid hairlines one step off the surface, behind the
            marks and out of the accessibility tree. */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {[0, 0.5, 1].map((fraction) => (
            <div
              key={fraction}
              className="absolute right-0 left-7 border-t border-border/50"
              style={{ top: `${fraction * 100}%` }}
            >
              <span className="absolute -top-1.5 left-0 w-6 -translate-x-full pr-1 text-right text-[10px] tabular-nums text-muted-foreground">
                {Math.round(ceiling * (1 - fraction))}
              </span>
            </div>
          ))}
        </div>

        <div className="relative">
          <div
            role="img"
            aria-label={`${caption}. ${grandTotal} in total across ${points.length} days.`}
            className="flex h-40 items-end gap-[2px]"
            onMouseLeave={() => setHovered(null)}
          >
            {points.map((point, index) => {
              const total = totals[index] ?? 0;
              return (
                <div
                  key={point.date}
                  // The whole column height is the hit target, not just the
                  // (possibly 1px tall) mark inside it.
                  className="group relative flex h-full flex-1 cursor-default flex-col justify-end"
                  onMouseEnter={() => setHovered(index)}
                  onFocus={() => setHovered(index)}
                  onBlur={() => setHovered(null)}
                  tabIndex={-1}
                >
                  <span
                    aria-hidden
                    className="absolute inset-0 rounded-sm bg-foreground/0 transition-colors duration-200 group-hover:bg-foreground/5"
                  />
                  <div className="relative mx-auto flex w-full max-w-6 flex-col justify-end gap-[2px]">
                    {total === 0 ? (
                      // A quiet day still gets a baseline stub, so "nothing
                      // happened" is visibly different from "no column here".
                      <span className="h-0.5 w-full rounded-full bg-border" />
                    ) : (
                      // Rendered top-down, so the series list reads bottom-up
                      // in the stack and matches the legend's order.
                      [...series]
                        .reverse()
                        .filter((entry) => (point.values[entry.key] ?? 0) > 0)
                        .map((entry, position) => (
                          <span
                            key={entry.key}
                            className={cn(
                              "w-full",
                              // 4px rounded data-end on the topmost segment
                              // only; everything below stays square so the
                              // stack reads as one column.
                              position === 0 && "rounded-t",
                            )}
                            style={{
                              backgroundColor: entry.color,
                              height: `${((point.values[entry.key] ?? 0) / ceiling) * 160}px`,
                              minHeight: 2,
                            }}
                          />
                        ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {active && activeIndex !== null && (
            <div
              // Pinned to the hovered column and flipped past the midpoint so
              // it never runs off either edge.
              className="pointer-events-none absolute -top-2 z-10 w-max max-w-56 rounded-lg border border-border bg-popover/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
              style={{
                left: `${((activeIndex + 0.5) / points.length) * 100}%`,
                // Flipped past the midpoint so a tooltip near the right edge
                // opens inwards instead of overflowing the card.
                transform:
                  activeIndex / points.length > 0.5
                    ? "translate(-100%, -100%)"
                    : "translate(0, -100%)",
              }}
            >
              <p className="font-medium">{formatDay(active.date)}</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {series.map((entry) => (
                  <li key={entry.key} className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: entry.color }}
                    />
                    <span className="text-muted-foreground">{entry.label}</span>
                    <span className="ml-auto font-medium tabular-nums">
                      {active.values[entry.key] ?? 0}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Only the ends and the middle are labelled — a tick under every
          column collides as soon as the range grows past a week; the tooltip
          and the table carry the rest. */}
      <div className="flex items-center justify-between gap-2 pl-7 text-[10px] tabular-nums text-muted-foreground">
        <span>{firstPoint && formatDay(firstPoint.date)}</span>
        {midPoint && <span>{formatDay(midPoint.date)}</span>}
        {lastPoint && <span>{formatDay(lastPoint.date)}</span>}
      </div>

      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {/* A single series needs no legend — the card's title already names
            what's plotted. */}
        {series.length > 1 &&
          series.map((entry) => (
            <span
              key={entry.key}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              {entry.label}
            </span>
          ))}
        <button
          type="button"
          onClick={() => setShowTable((open) => !open)}
          aria-expanded={showTable}
          aria-controls={tableId}
          className="ml-auto rounded text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          {showTable ? "Hide data" : "Show data"}
        </button>
      </figcaption>

      {/* The table isn't just an a11y fallback — it's the exact values the
          chart only approximates, available to anyone who wants them. */}
      <div id={tableId} hidden={!showTable} className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">{caption}</caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                Day
              </th>
              {series.map((entry) => (
                <th
                  key={entry.key}
                  scope="col"
                  className="py-1 pr-3 text-right font-medium"
                >
                  {entry.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.date} className="border-t border-border/50">
                <th scope="row" className="py-1 pr-3 font-normal">
                  {formatDay(point.date)}
                </th>
                {series.map((entry) => (
                  <td
                    key={entry.key}
                    className="py-1 pr-3 text-right tabular-nums"
                  >
                    {point.values[entry.key] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
