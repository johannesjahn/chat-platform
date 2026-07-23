import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

// The unified search box in the app header (issue #224). Submitting navigates
// to the `/search` results page with the query in the URL, which is the single
// source of truth for what's being searched — so this input stays a thin entry
// point and the results page owns the actual querying/pagination.
export function HeaderSearch() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");

  return (
    <form
      role="search"
      className="relative min-w-0 flex-1 sm:max-w-xs"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        void navigate({ to: "/search", search: q ? { q } : {} });
      }}
    >
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search…"
        aria-label="Search"
        className="h-9 pl-8"
      />
    </form>
  );
}
