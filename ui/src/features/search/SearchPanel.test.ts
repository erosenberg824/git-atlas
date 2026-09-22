import { describe, it, expect } from "vitest";
import { isSearchDisabled } from "./SearchPanel";

/**
 * Reference oracle for the disabled rule, expressed independently of the
 * implementation: the button is disabled iff a search is in flight OR the
 * query has no non-whitespace character.
 */
function expectedDisabled(query: string, loading: boolean): boolean {
  return loading || query.trim().length === 0;
}

/**
 * Small, fully-deterministic PRNG (mulberry32). No external dependency, no
 * reliance on Math.random — so the generated cases are identical on every run
 * and offline, per project testing conventions.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Character pool that mixes whitespace and non-whitespace so generated queries
// exercise both "whitespace-only" and "has content" branches of the rule.
const CHAR_POOL = [
  " ",
  "\t",
  "\n",
  "\r",
  "\f",
  "\v",
  "\u00a0", // non-breaking space (whitespace per String.prototype.trim)
  "a",
  "Z",
  "0",
  "9",
  "_",
  "-",
  ".",
  "/",
  "é",
  "字",
];

function randomQuery(rand: () => number): string {
  const len = Math.floor(rand() * 9); // 0..8 chars (includes empty string)
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CHAR_POOL[Math.floor(rand() * CHAR_POOL.length)];
  }
  return s;
}

describe("isSearchDisabled", () => {
  // Property 1: Search-disabled predicate matches empty-or-loading rule.
  // Validates: Requirements 2.1, 2.2, 2.3, 3.2
  it("matches the empty-or-loading rule across generated inputs", () => {
    const rand = mulberry32(0x5ea4c8);
    const iterations = 500; // well above the 100-iteration minimum
    for (let i = 0; i < iterations; i++) {
      const query = randomQuery(rand);
      const loading = rand() < 0.5;

      const actual = isSearchDisabled(query, loading);
      const expected = expectedDisabled(query, loading);

      expect(
        actual,
        `query=${JSON.stringify(query)} loading=${loading}`,
      ).toBe(expected);

      // Cross-check the biconditional directly: disabled iff loading OR
      // whitespace-only; enabled iff not loading AND has a non-whitespace char.
      const hasContent = query.trim().length > 0;
      if (!loading && hasContent) {
        expect(actual).toBe(false);
      } else {
        expect(actual).toBe(true);
      }
    }
  });

  // Explicit edge cases spanning both loading states, per task 1.4.
  const queryCases: { label: string; query: string; whitespaceOnly: boolean }[] = [
    { label: "empty string", query: "", whitespaceOnly: true },
    { label: "single space", query: " ", whitespaceOnly: true },
    { label: "multiple spaces", query: "   ", whitespaceOnly: true },
    { label: "tab + newline", query: "\t\n", whitespaceOnly: true },
    { label: "mixed whitespace", query: " \t \r\n ", whitespaceOnly: true },
    { label: "single non-space char", query: "x", whitespaceOnly: false },
    { label: "leading/trailing spaces around content", query: " x ", whitespaceOnly: false },
    { label: "content with internal spaces", query: "a b", whitespaceOnly: false },
  ];

  for (const { label, query, whitespaceOnly } of queryCases) {
    it(`${label}: disabled while loading`, () => {
      expect(isSearchDisabled(query, true)).toBe(true);
    });

    it(`${label}: not loading → disabled iff whitespace-only`, () => {
      expect(isSearchDisabled(query, false)).toBe(whitespaceOnly);
    });
  }
});
