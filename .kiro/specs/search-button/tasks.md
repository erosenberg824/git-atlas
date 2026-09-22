# Implementation Plan: Search Button

## Overview

Convert the decorative magnifying-glass icon in `ui/src/features/search/SearchPanel.tsx` into a real, accessible, clickable button that runs the current search — matching the Enter-key behavior. The change is frontend-only and confined to one file, plus a colocated unit test. A small pure predicate `isSearchDisabled(query, loading)` is extracted for the disabled rule and unit-tested directly; the button markup, spinner swap, and Enter-key preservation are verified via the TypeScript strict build and the frontend test run.

## Tasks

- [x] 1. Extract and wire the search button in SearchPanel
  - [x] 1.1 Add the `isSearchDisabled` pure helper
    - Export `isSearchDisabled(query: string, loading: boolean): boolean` from `SearchPanel.tsx`, returning `loading || query.trim().length === 0`
    - Keep the emptiness definition identical to the `!q.trim()` guard inside `runSearch`
    - No `any`; strict mode compliant
    - _Requirements: 2.1, 2.2, 2.3, 6.3_

  - [x] 1.2 Replace the decorative icon with a real button
    - Replace the decorative `Search` icon in the input row with a `<button type="button">`
    - `onClick={() => runSearch(query)}`, `disabled={isSearchDisabled(query, loading)}`, `aria-label="Run search"`
    - Style with existing Tailwind dark-theme tokens (`#8b949e` / `#e6edf3`) plus `disabled:` variants
    - Leave the `handleKeyDown` Enter-key path untouched
    - _Requirements: 1.1, 1.2, 1.3, 2.4, 3.1, 3.2, 5.1, 5.2, 5.3, 6.1, 6.2_

  - [x] 1.3 Swap the icon/spinner inside the single button slot
    - Render `Loader2` (with `animate-spin`) inside the button while `loading` is true, otherwise render `Search`
    - Ensure the button is the input row's single trailing control (no redundant second icon)
    - _Requirements: 4.1, 4.2_

  - [x]* 1.4 Write property test for `isSearchDisabled`
    - Colocated `SearchPanel.test.ts` (Vitest, node env)
    - **Property 1: Search-disabled predicate matches empty-or-loading rule** — returns `true` iff `loading` is true OR `query` is whitespace-only; `false` iff `loading` is false AND `query` has a non-whitespace char. Minimum 100 generated iterations.
    - **Validates: Requirements 2.1, 2.2, 2.3, 3.2**

- [x] 2. Checkpoint - Verify build and tests
  - Run `tsc` strict build (no `any`, no errors) and `mise run test-ui`
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP.
- Each task references specific requirements for traceability.
- DOM/component tests are intentionally omitted per project conventions; button markup, aria attributes, styling, and Enter-key behavior are verified via the TypeScript strict build plus the frontend test run.
- The only pure logic introduced (`isSearchDisabled`) is extracted specifically so it can be unit-tested directly.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.4"] },
    { "id": 2, "tasks": ["1.3"] }
  ]
}
```
