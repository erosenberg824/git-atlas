import type { TreeEntry } from "../../api/client";

/**
 * A node in the nested file tree built from the server's flat path list.
 * Intermediate directories are synthesized (kind `"tree"`) as needed.
 */
export interface TreeNode {
  name: string;
  path: string;
  kind: TreeEntry["kind"];
  size: number | null;
  children: Map<string, TreeNode>;
}

/**
 * Turn the server's flat list of paths (e.g. `src/api/client.ts`) into a nested
 * `TreeNode` map keyed by path segment, synthesizing intermediate directories
 * so the browser can render a collapsible tree.
 *
 * Pure: no DOM, no state. Unit-tested in `fileTree.test.ts`.
 */
export function buildTree(entries: TreeEntry[]): Map<string, TreeNode> {
  const root = new Map<string, TreeNode>();

  for (const entry of entries) {
    const parts = entry.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const partialPath = parts.slice(0, i + 1).join("/");

      if (!current.has(part)) {
        current.set(part, {
          name: part,
          path: partialPath,
          kind: isLast ? entry.kind : "tree",
          size: isLast ? entry.size : null,
          children: new Map(),
        });
      }
      current = current.get(part)!.children;
    }
  }

  return root;
}

/**
 * Comparator ordering directories before files, then alphabetically by name
 * (locale-aware). Used to sort siblings at every level of the tree.
 */
export function compareTreeNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind === "tree" && b.kind !== "tree") return -1;
  if (a.kind !== "tree" && b.kind === "tree") return 1;
  return a.name.localeCompare(b.name);
}

/** Sort a node map's values with {@link compareTreeNodes}. */
export function sortedTreeNodes(nodes: Map<string, TreeNode>): TreeNode[] {
  return [...nodes.values()].sort(compareTreeNodes);
}

/** Human-readable byte size (B / KB / MB), matching the file browser display. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
