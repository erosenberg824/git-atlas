import { useState, useRef } from "react";
import { Search, Loader2 } from "lucide-react";
import { api, type SearchResponse } from "../../api/client";

/**
 * Whether the search trigger should be disabled.
 * Disabled when a search is in flight, or the query is empty/whitespace-only.
 * The emptiness definition (`query.trim().length === 0`) is intentionally
 * identical to the `!q.trim()` guard inside `runSearch`, so the button's
 * disabled state and the search guard agree on what "empty" means.
 */
export function isSearchDisabled(query: string, loading: boolean): boolean {
  return loading || query.trim().length === 0;
}

interface SearchPanelProps {
  /** Commit to search at (full-text search is scoped to a commit's tree). Null = none selected. */
  commitOid: string | null;
  /** Called when a search result file is clicked. */
  onSelectFile: (path: string) => void;
}

/**
 * Full-text search panel: queries the tantivy index for the selected commit
 * (GET /search) and lists matching files with snippet previews. Building the
 * index for a commit happens server-side on first query.
 */
export default function SearchPanel({ commitOid, onSelectFile }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function runSearch(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.search.query(q, commitOid ?? undefined);
      setResults(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") runSearch(query);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search input */}
      <div className="p-3 border-b border-[#30363d]">
        <div className="flex items-center gap-2 bg-[#0d1117] border border-[#30363d] rounded-md px-3 py-1.5 focus-within:border-blue-500/60">
          <button
            type="button"
            onClick={() => runSearch(query)}
            disabled={isSearchDisabled(query, loading)}
            aria-label="Run search"
            className="shrink-0 text-[#8b949e] hover:text-[#e6edf3] disabled:opacity-50 disabled:cursor-default transition-colors"
          >
            {loading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Search size={14} />
            )}
          </button>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search files at this commit…"
            className="flex-1 bg-transparent text-sm text-[#e6edf3] outline-none placeholder:text-[#8b949e]"
          />
        </div>
        {commitOid && (
          <p className="text-[10px] text-[#8b949e] mt-1 font-mono">
            at {commitOid.slice(0, 8)}
          </p>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto">
        {error && (
          <div className="p-3 text-sm text-red-400">{error}</div>
        )}

        {results && !loading && (
          <>
            {results.results.length === 0 ? (
              <div className="p-3 text-sm text-[#8b949e]">No results for "{results.query}"</div>
            ) : (
              <div>
                <div className="px-3 py-1.5 text-xs text-[#8b949e] border-b border-[#30363d]">
                  {results.results.length} result{results.results.length !== 1 ? "s" : ""}
                </div>
                {results.results.map((result, i) => (
                  <button
                    key={i}
                    onClick={() => onSelectFile(result.path)}
                    className="w-full text-left px-3 py-2 border-b border-[#30363d]/50 hover:bg-[#21262d] transition-colors"
                  >
                    <div className="text-sm font-mono text-blue-400 truncate">
                      {result.path}
                    </div>
                    {result.snippets.map((s, j) => (
                      <div key={j} className="text-xs text-[#8b949e] font-mono truncate mt-0.5">
                        {s}
                      </div>
                    ))}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {!results && !loading && !error && (
          <div className="p-4 text-sm text-[#8b949e]">
            Type a search term and press Enter.
            <br />
            <span className="text-xs">Supports full-text search across all files.</span>
          </div>
        )}
      </div>
    </div>
  );
}
