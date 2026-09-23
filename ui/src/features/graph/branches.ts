import type { RefLabel } from "../../api/client";

/**
 * Per-branch visibility for the graph:
 *  - "expanded"  — show the branch's commits in full
 *  - "collapsed" — show the branch as a single "virtual squash" rollup node
 *  - "hidden"    — don't include the branch at all
 */
export type BranchVisibility = "expanded" | "collapsed" | "hidden";

/** How many non-main branches to collapse-by-default (most recent by tip date). */
export const DEFAULT_RECENT_BRANCHES = 5;

/** A branch ref (local or remote), with its tip commit + recency. */
export interface BranchInfo {
  name: string;
  oid: string;
  isHead: boolean;
  tipTs: number | null;
  remote: boolean;
  /** For local branches: short name of the configured upstream (e.g. "origin/main"). */
  upstream: string | null;
}

/** Extract branch refs (local + remote) from the ref list, newest tip first. */
export function branchesFromRefs(refs: RefLabel[]): BranchInfo[] {
  const branches = refs
    .filter((r) => r.kind === "branch" || r.kind === "remotebranch")
    .map((r) => ({
      name: r.name,
      oid: r.oid,
      isHead: r.is_head,
      tipTs: r.tip_ts,
      remote: r.kind === "remotebranch",
      upstream: r.upstream,
    }));
  branches.sort((a, b) => (b.tipTs ?? 0) - (a.tipTs ?? 0));
  return branches;
}

/** The tri-state cycle transition: expanded → collapsed → hidden → expanded. */
export function nextVisibility(v: BranchVisibility): BranchVisibility {
  return v === "expanded" ? "collapsed" : v === "collapsed" ? "hidden" : "expanded";
}

/**
 * Compute the default visibility per branch:
 *  - the current branch (HEAD) and `main`/`master` → expanded
 *  - the next ~N most-recent branches by tip date → collapsed (virtual squash)
 *  - everything else → hidden
 */
export function defaultVisibility(
  branches: BranchInfo[],
  recentCount = DEFAULT_RECENT_BRANCHES,
): Map<string, BranchVisibility> {
  const vis = new Map<string, BranchVisibility>();
  const isMain = (n: string) => n === "main" || n === "master";

  // Expanded set: HEAD + main/master.
  const expanded = new Set<string>();
  for (const b of branches) {
    if (b.isHead || isMain(b.name)) expanded.add(b.name);
  }

  // Collapse the next N most-recent branches not already expanded.
  let collapsedTaken = 0;
  for (const b of branches) {
    if (expanded.has(b.name)) {
      vis.set(b.name, "expanded");
    } else if (collapsedTaken < recentCount) {
      vis.set(b.name, "collapsed");
      collapsedTaken++;
    } else {
      vis.set(b.name, "hidden");
    }
  }
  return vis;
}

/** Branch names that should be sent to the server as visible (collapsed + expanded). */
export function shownBranchNames(vis: Map<string, BranchVisibility>): string[] {
  const out: string[] = [];
  for (const [name, v] of vis) if (v !== "hidden") out.push(name);
  return out;
}
