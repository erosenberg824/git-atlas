import { describe, it, expect } from "vitest";
import type { TreeEntry } from "../../api/client";
import {
  buildTree,
  compareTreeNodes,
  sortedTreeNodes,
  formatSize,
  type TreeNode,
} from "./fileTree";

function entry(
  path: string,
  kind: TreeEntry["kind"] = "blob",
  size: number | null = 0,
): TreeEntry {
  return { path, kind, size, oid: `oid-${path}` };
}

/** Convenience: get a nested node by its slash path from the built tree. */
function at(root: Map<string, TreeNode>, path: string): TreeNode | undefined {
  const parts = path.split("/");
  let current: Map<string, TreeNode> | undefined = root;
  let node: TreeNode | undefined;
  for (const part of parts) {
    if (!current) return undefined;
    node = current.get(part);
    current = node?.children;
  }
  return node;
}

describe("buildTree", () => {
  it("returns an empty map for no entries", () => {
    expect(buildTree([]).size).toBe(0);
  });

  it("places a single top-level file at the root", () => {
    const tree = buildTree([entry("README.md", "blob", 42)]);
    expect(tree.size).toBe(1);
    const node = tree.get("README.md")!;
    expect(node).toMatchObject({
      name: "README.md",
      path: "README.md",
      kind: "blob",
      size: 42,
    });
    expect(node.children.size).toBe(0);
  });

  it("synthesizes intermediate directories from a nested path", () => {
    const tree = buildTree([entry("src/api/client.ts", "blob", 100)]);

    const src = tree.get("src")!;
    expect(src).toMatchObject({ name: "src", path: "src", kind: "tree", size: null });

    const api = src.children.get("api")!;
    expect(api).toMatchObject({ name: "api", path: "src/api", kind: "tree", size: null });

    const file = api.children.get("client.ts")!;
    expect(file).toMatchObject({
      name: "client.ts",
      path: "src/api/client.ts",
      kind: "blob",
      size: 100,
    });
  });

  it("merges files that share a directory prefix", () => {
    const tree = buildTree([
      entry("src/a.ts", "blob", 1),
      entry("src/b.ts", "blob", 2),
    ]);
    expect(tree.size).toBe(1);
    const src = tree.get("src")!;
    expect(src.kind).toBe("tree");
    expect([...src.children.keys()].sort()).toEqual(["a.ts", "b.ts"]);
    expect(src.children.get("a.ts")!.size).toBe(1);
    expect(src.children.get("b.ts")!.size).toBe(2);
  });

  it("does not overwrite a synthesized directory when it reappears as a prefix", () => {
    const tree = buildTree([
      entry("src/deep/x.ts", "blob", 5),
      entry("src/y.ts", "blob", 6),
    ]);
    const src = tree.get("src")!;
    // src stays a synthesized tree with both a subdir and a file
    expect(src.kind).toBe("tree");
    expect(src.children.has("deep")).toBe(true);
    expect(src.children.has("y.ts")).toBe(true);
    expect(at(tree, "src/deep/x.ts")!.size).toBe(5);
  });

  it("preserves non-blob kinds on leaf entries", () => {
    const tree = buildTree([
      entry("link", "symlink", null),
      entry("submodule", "commit", null),
    ]);
    expect(tree.get("link")!.kind).toBe("symlink");
    expect(tree.get("submodule")!.kind).toBe("commit");
  });

  it("keeps the first entry's metadata when the same path repeats", () => {
    const tree = buildTree([
      entry("dup.ts", "blob", 10),
      entry("dup.ts", "blob", 999),
    ]);
    // second occurrence is ignored because the node already exists
    expect(tree.get("dup.ts")!.size).toBe(10);
  });
});

describe("compareTreeNodes / sortedTreeNodes", () => {
  const dir = (name: string): TreeNode => ({
    name,
    path: name,
    kind: "tree",
    size: null,
    children: new Map(),
  });
  const file = (name: string): TreeNode => ({
    name,
    path: name,
    kind: "blob",
    size: 0,
    children: new Map(),
  });

  it("orders directories before files", () => {
    expect(compareTreeNodes(dir("z"), file("a"))).toBeLessThan(0);
    expect(compareTreeNodes(file("a"), dir("z"))).toBeGreaterThan(0);
  });

  it("orders same-kind nodes alphabetically", () => {
    expect(compareTreeNodes(file("a"), file("b"))).toBeLessThan(0);
    expect(compareTreeNodes(dir("y"), dir("x"))).toBeGreaterThan(0);
    expect(compareTreeNodes(file("same"), file("same"))).toBe(0);
  });

  it("sorts a mixed map: dirs first, then files, each alphabetical", () => {
    const tree = buildTree([
      entry("zeta.ts", "blob", 1),
      entry("alpha.ts", "blob", 1),
      entry("lib/x.ts", "blob", 1),
      entry("app/y.ts", "blob", 1),
    ]);
    const names = sortedTreeNodes(tree).map((n) => n.name);
    expect(names).toEqual(["app", "lib", "alpha.ts", "zeta.ts"]);
  });
});

describe("formatSize", () => {
  it("formats bytes below 1KB with a B suffix", () => {
    expect(formatSize(0)).toBe("0B");
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(1023)).toBe("1023B");
  });

  it("formats kilobytes with one decimal", () => {
    expect(formatSize(1024)).toBe("1.0KB");
    expect(formatSize(1536)).toBe("1.5KB");
    expect(formatSize(1024 * 1024 - 1)).toBe("1024.0KB");
  });

  it("formats megabytes with one decimal", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0MB");
    expect(formatSize(1024 * 1024 * 2.5)).toBe("2.5MB");
  });
});
