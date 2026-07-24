import type { SearchSnippetSegment } from "@/lib/search";

// Renders a search snippet's runs as escaped text, wrapping matched runs in
// `<mark>`. Each run's `text` is placed as a React text child, so the browser
// escapes it — user content that contains markup (e.g. "<script>") renders as
// literal characters, never as HTML. This is the sole place snippet text is
// shown, so highlighting can never become an injection vector (see
// `SearchSnippetSegment` in src/Api.ts and the parse in src/search.ts).
export function SearchHighlight({
  snippet,
  className,
}: {
  snippet: ReadonlyArray<SearchSnippetSegment>;
  className?: string;
}) {
  return (
    <span className={className}>
      {snippet.map((segment, i) =>
        segment.match ? (
          <mark
            key={i}
            className="rounded-sm bg-primary/25 px-0.5 text-foreground"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </span>
  );
}
