import { describe, it, expect } from "vitest";
import { branchesFromRefs, type BranchInfo } from "./branches";
import { groupBranches, isPaired, remoteShortName } from "./branchGroups";
import type { RefLabel } from "../../api/client";

const local = (
  name: string,
  tip_ts: number,
  upstream: string | null = null,
  is_head = false,
): RefLabel => ({ name, oid: name, kind: "branch", is_head, tip_ts, upstream });

const remote = (name: string, tip_ts: number): RefLabel => ({
  name,
  oid: name,
  kind: "remotebranch",
  is_head: false,
  tip_ts,
  upstream: null,
});

const names = (bs: BranchInfo[]) => bs.map((b) => b.name);

describe("remoteShortName", () => {
  it("strips the remote prefix (first path segment)", () => {
    expect(remoteShortName("origin/main")).toBe("main");
    expect(remoteShortName("upstream/feature/x")).toBe("feature/x");
  });
  it("returns null when there is no slash", () => {
    expect(remoteShortName("main")).toBeNull();
  });
});

describe("groupBranches", () => {
  it("pairs a local branch with the remote sharing its short name", () => {
    const branches = branchesFromRefs([
      local("main", 5000, "origin/main", true),
      remote("origin/main", 4900),
    ]);
    const groups = groupBranches(branches);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(isPaired(g)).toBe(true);
    expect(g.local?.name).toBe("main");
    expect(names(g.remotes)).toEqual(["origin/main"]);
    expect(g.members.sort()).toEqual(["main", "origin/main"]);
  });

  it("gathers MULTIPLE remotes that share the local's short name", () => {
    const branches = branchesFromRefs([
      local("main", 5000, "origin/main", true),
      remote("origin/main", 4900),
      remote("upstream/main", 4800),
    ]);
    const groups = groupBranches(branches);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(isPaired(g)).toBe(true);
    expect(g.remotes).toHaveLength(2);
    // Configured upstream (origin/main) ordered first, then the rest by name.
    expect(names(g.remotes)).toEqual(["origin/main", "upstream/main"]);
    expect(g.members).toEqual(["main", "origin/main", "upstream/main"]);
  });

  it("orders remotes with the configured upstream first, then by name", () => {
    const branches = branchesFromRefs([
      local("main", 5000, "upstream/main"),
      remote("origin/main", 4900),
      remote("upstream/main", 4800),
      remote("fork/main", 4700),
    ]);
    const [g] = groupBranches(branches);
    expect(names(g.remotes)).toEqual(["upstream/main", "fork/main", "origin/main"]);
  });

  it("pairs by name even without a configured upstream", () => {
    // No upstream set, but origin/main shares the short name → still grouped.
    const branches = branchesFromRefs([
      local("main", 5000),
      remote("origin/main", 4900),
    ]);
    const [g] = groupBranches(branches);
    expect(isPaired(g)).toBe(true);
    expect(names(g.remotes)).toEqual(["origin/main"]);
  });

  it("keeps a local branch with no matching remote as a singleton", () => {
    const branches = branchesFromRefs([local("feature", 3000)]);
    const groups = groupBranches(branches);
    expect(groups).toHaveLength(1);
    expect(isPaired(groups[0])).toBe(false);
    expect(groups[0].local?.name).toBe("feature");
    expect(groups[0].remotes).toEqual([]);
    expect(groups[0].members).toEqual(["feature"]);
  });

  it("keeps an ungrouped remote branch as a singleton", () => {
    const branches = branchesFromRefs([remote("origin/orphan", 2000)]);
    const groups = groupBranches(branches);
    expect(groups).toHaveLength(1);
    expect(isPaired(groups[0])).toBe(false);
    expect(groups[0].local).toBeUndefined();
    expect(names(groups[0].remotes)).toEqual(["origin/orphan"]);
    expect(groups[0].members).toEqual(["origin/orphan"]);
  });

  it("orders groups by most-recent member tip (newest first)", () => {
    const branches = branchesFromRefs([
      local("old", 1000),
      local("main", 5000, "origin/main", true),
      remote("origin/main", 100), // remote is stale, but the group's local tip is newest
      local("mid", 3000),
    ]);
    const groups = groupBranches(branches);
    // main group (tip 5000) first, then mid (3000), then old (1000).
    expect(groups.map((g) => g.local?.name ?? g.remotes[0]?.name)).toEqual([
      "main",
      "mid",
      "old",
    ]);
  });

  it("preserves HEAD on the local member", () => {
    const branches = branchesFromRefs([
      local("main", 5000, "origin/main", true),
      remote("origin/main", 4900),
    ]);
    const [g] = groupBranches(branches);
    expect(g.local?.isHead).toBe(true);
    expect(g.remotes[0].isHead).toBe(false);
    expect(names([g.local!, ...g.remotes])).toEqual(["main", "origin/main"]);
  });
});
