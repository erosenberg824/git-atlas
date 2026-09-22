# Design Document

## Overview

This feature upgrades the SearchPanel's decorative magnifying-glass icon into a real, accessible, clickable button that runs the current search — matching the behavior of pressing Enter — while preserving the existing Enter-key trigger and the loading-spinner behavior.

The change is confined to a single file, `ui/src/features/search/SearchPanel.tsx`. No server, API, or sibling search component (FindRefBox, BranchControl) is affected. The search execution path (`runSearch`), its empty-query guard, and the network call (`api.search.query`) are unchanged; we only add a new UI affordance that routes to the same entry point and introduce a small pure predicate for the disabled state.

## Architecture

The component already centralizes search execution in a single async function, `runSearch(q: string)`. Both existing (Enter key) and new (button click) triggers route through it:

```
                 ┌──────────────────────────┐
  Enter key ────►│ handleKeyDown(e)          │
                 │   if e.key==="Enter" ─────┼──┐
                 └──────────────────────────┘   │
                 ┌──────────────────────────┐   ├──► runSearch(query) ──► api.search.query(...)
  Button click ─►│ onClick={() => runSearch}│───┘        │
                 └──────────────────────────┘            └─ guards: if (!q.trim()) return
```

`runSearch` retains its `if (!q.trim()) return;` guard, so it is safe even if it is ever called with an empty query. The button additionally uses the native `disabled` attribute to prevent activation entirely when there is nothing to search or a search is in flight — giving us both a defensive guard and correct accessibility semantics.

### Loading-spinner approach (decision)

The current input row renders the decorative `Search` icon and, while `loading`, an additional `Loader2` spinner in a separate slot. To keep the row clean and unambiguous, the design **swaps** the icon inside the single button slot rather than showing two icons:

- When `loading` is `false`: the button shows the `Search` (magnifying-glass) icon.
- When `loading` is `true`: the button shows the animated `Loader2` spinner and is disabled.

This keeps one control in the row, preserves the "spinner while searching" requirement (Req 4), and avoids a redundant second icon. The spinner therefore lives *inside* the button; the button is the input row's single trailing control.

## Components and Interfaces

### `isSearchDisabled` (new pure helper)

A single pure predicate encapsulates the enable/disable rule. Extracting it keeps the JSX simple and makes the rule unit-testable in isolation (the only pure logic this feature introduces).

```typescript
/**
 * Whether the search trigger should be disabled.
 * Disabled when the query is empty/whitespace-only, or a search is in flight.
 */
export function isSearchDisabled(query: string, loading: boolean): boolean {
  return loading || query.trim().length === 0;
}
```

Placement: exported from `SearchPanel.tsx` (or a colocated `searchPanel.logic.ts` if preferred) so a `*.test.ts` can import it without touching the DOM. The emptiness definition (`query.trim().length === 0`) is intentionally identical to the guard inside `runSearch` (`!q.trim()`), so the button's disabled state and the search guard agree on what "empty" means.

### SearchPanel button markup (replacing the decorative icon)

```tsx
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
```

- `type="button"` prevents any implicit form-submit behavior.
- `aria-label="Run search"` supplies the Accessible_Label (Req 5.1); the button contains only an icon, so a visible text label is absent by design.
- Native `disabled` makes the control non-focusable/non-activatable and exposes disabled state to assistive tech (Req 2, Req 5.3).
- Native `<button>` is keyboard-focusable and Enter/Space-activatable when enabled (Req 5.2).
- Tailwind classes reuse the panel's existing dark-theme tokens (`#8b949e`, `#e6edf3`) and add `disabled:` variants for the disabled affordance (Req 6.2).

The Enter-key path (`handleKeyDown`) is left exactly as-is (Req 3).

## Data Models

No new data models. The feature operates entirely on existing component state:

| State | Type | Role |
|---|---|---|
| `query` | `string` | Current Search_Query; drives the disabled predicate and is passed to `runSearch`. |
| `loading` | `boolean` | In_Flight_Search flag; drives the spinner and the disabled predicate. |
| `results` | `SearchResponse \| null` | Existing results state; unchanged. |
| `error` | `string \| null` | Existing error state; unchanged. |

## Error Handling

Error handling is unchanged. `runSearch` continues to `try/catch` around `api.search.query`, set `error` on failure, and reset `loading` in `finally`. Because the button is disabled while `loading` is true, users cannot launch overlapping searches from the button; the empty-query guard in `runSearch` remains as a secondary safeguard against empty submissions.

## Testing Strategy

Per project conventions, DOM/component tests are **not** required for this change — the component wiring, rendering, aria attributes, and styling are verified via the TypeScript strict build (`tsc`) plus manual verification. TypeScript strict mode also enforces the no-`any` requirement (Req 6.3).

The only pure logic introduced is `isSearchDisabled(query, loading)`. It is extracted specifically so it can be unit-tested directly (Vitest, node environment, colocated `*.test.ts`), consistent with the project's "extract pure logic out of components so it can be unit-tested" convention. This is the single testable-as-a-property behavior; everything else is interaction, presentation, or native semantics.

- **Property test**: `isSearchDisabled` across generated inputs (see Correctness Properties). Minimum 100 iterations.
- **No integration/e2e** work: the change adds no I/O and touches no server code.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Search-disabled predicate matches empty-or-loading rule

For any query string `q` and any boolean `loading`, `isSearchDisabled(q, loading)` returns `true` if and only if `loading` is `true` OR `q` contains only whitespace (including the zero-length string), and returns `false` exactly when `loading` is `false` AND `q` contains at least one non-whitespace character. This single predicate governs both when the button is disabled and, via the shared emptiness definition, when an empty-query search is suppressed.

**Validates: Requirements 2.1, 2.2, 2.3, 3.2**
