import type { BranchInfo } from "./branches";

/**
 * A branch group in the picker: a local branch together with every
 * remote-tracking branch that shares its short name (e.g. local `main` with
 * `origin/main` **and** `upstream/main`), or a singleton when a branch has no
 * counterpart.
 *  - `local`   — the local branch (present unless the group is a bare remote)
 *  - `remotes` — the matched remote-tracking branches (0..n), ordered with the
 *                configured upstream first, then by name
 *  - `members` — the branch names the group's grouped control toggles together
 *
 * A group is "paired" iff `local` is set and at least one remote matched.
 */
export interface BranchGroup {
  local?: BranchInfo;
  remotes: BranchInfo[];
  members: string[];
}

/** True when the group pairs a local branch with one or more tracked remotes. */
export function isPaired(g: BranchGroup): boolean {
  return g.local !== undefined && g.remotes.length > 0;
}

/**
 * The short branch name of a remote-tracking ref: everything after the first
 * path segment (the remote name). `origin/main` → `main`,
 * `upstream/feature/x` → `feature/x`. Returns null if there's no `/`.
 */
export function remoteShortName(remoteRef: string): string | null {
  const slash = remoteRef.indexOf("/");
  return slash > 0 ? remoteRef.slice(slash + 1) : null;
}

/** A group's most-recent member tip (used to preserve recency ordering). */
function groupTipTs(g: BranchGroup): number {
  const tips = [g.local?.tipTs ?? -Infinity, ...g.remotes.map((r) => r.tipTs ?? -Infinity)];
  return Math.max(...tips);
}

/**
 * Group branches by short name across remotes.
 *
 * Each local branch gathers every remote-tracking branch whose short name
 * matches the local's name — so local `main` groups both `origin/main` and
 * `upstream/main`. Within a group the remotes are ordered with the local's
 * configured `upstream` first (when present), then alphabetically. Branches
 * with no counterpart — a local branch with no matching remote, or a remote
 * branch whose short name matches no local branch — become singleton groups.
 *
 * The returned list preserves recency ordering (newest member tip first);
 * each group is placed at its most-recent member's position.
 */
export function groupBranches(branches: BranchInfo[]): BranchGroup[] {
  const locals = branches.filter((b) => !b.remote);
  const remotes = branches.filter((b) => b.remote);

  // Index remotes by their short branch name so a local can gather all of them.
  const remotesByShort = new Map<string, BranchInfo[]>();
  for (const r of remotes) {
    const short = remoteShortName(r.name);
    if (short === null) continue;
    const list = remotesByShort.get(short);
    if (list) list.push(r);
    else remotesByShort.set(short, [r]);
  }

  const groups: BranchGroup[] = [];
  const consumedRemotes = new Set<string>();

  for (const local of locals) {
    const matched = remotesByShort.get(local.name) ?? [];
    if (matched.length > 0) {
      // Order: configured upstream first, then by name.
      const ordered = [...matched].sort((a, b) => {
        if (a.name === local.upstream) return -1;
        if (b.name === local.upstream) return 1;
        return a.name.localeCompare(b.name);
      });
      for (const r of ordered) consumedRemotes.add(r.name);
      groups.push({
        local,
        remotes: ordered,
        members: [local.name, ...ordered.map((r) => r.name)],
      });
    } else {
      groups.push({ local, remotes: [], members: [local.name] });
    }
  }

  // Remote branches not gathered by any local branch → singleton groups
  // (no local, a single remote member).
  for (const remote of remotes) {
    if (consumedRemotes.has(remote.name)) continue;
    groups.push({ remotes: [remote], members: [remote.name] });
  }

  // Preserve recency ordering across all groups (newest member tip first).
  groups.sort((a, b) => groupTipTs(b) - groupTipTs(a));
  return groups;
}
