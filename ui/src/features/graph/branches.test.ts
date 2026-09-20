import { describe, it, expect } from "vitest";
import { branchesFromRefs, defaultVisibility, shownBranchNames } from "./branches";
import type { RefLabel } from "../../api/client";

const branch = (name: string, tip_ts: number, is_head = false): RefLabel => ({
  name,
  oid: name,
  kind: "branch",
  is_head,
  tip_ts,
});

describe("branchesFromRefs", () => {
  it("keeps only branches, sorted by tip date (newest first)", () => {
    const refs: RefLabel[] = [
      branch("old", 1000),
      branch("new", 5000),
      { name: "v1", oid: "t", kind: "tag", is_head: false, tip_ts: 9000 },
      branch("mid", 3000),
    ];
    const bs = branchesFromRefs(refs);
    expect(bs.map((b) => b.name)).toEqual(["new", "mid", "old"]); // tags excluded, sorted
  });
});

describe("defaultVisibility", () => {
  it("expands main/HEAD, collapses recent, hides the rest", () => {
    const refs: RefLabel[] = [
      branch("main", 100, true),
      branch("r1", 90),
      branch("r2", 80),
      branch("r3", 70),
      branch("r4", 60),
      branch("r5", 50),
      branch("old1", 40),
      branch("old2", 30),
    ];
    const vis = defaultVisibility(branchesFromRefs(refs), 3);
    expect(vis.get("main")).toBe("expanded");
    // top 3 recent (non-main) collapsed
    expect(vis.get("r1")).toBe("collapsed");
    expect(vis.get("r2")).toBe("collapsed");
    expect(vis.get("r3")).toBe("collapsed");
    // the rest hidden
    expect(vis.get("r4")).toBe("hidden");
    expect(vis.get("old2")).toBe("hidden");
  });

  it("treats master as main", () => {
    const vis = defaultVisibility(branchesFromRefs([branch("master", 100)]), 5);
    expect(vis.get("master")).toBe("expanded");
  });
});

describe("shownBranchNames", () => {
  it("returns collapsed + expanded, not hidden", () => {
    const vis = new Map<string, "expanded" | "collapsed" | "hidden">([
      ["a", "expanded"],
      ["b", "collapsed"],
      ["c", "hidden"],
    ]);
    expect(shownBranchNames(vis).sort()).toEqual(["a", "b"]);
  });
});
