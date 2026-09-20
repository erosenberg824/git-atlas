import { useState } from "react";
import { FileText, Folder, ChevronRight } from "lucide-react";
import type { TreeEntry } from "../../api/client";

interface FileBrowserProps {
  /** Flat list of tree entries (files + dirs) for a commit, from GET /tree/:oid. */
  entries: TreeEntry[];
  /** Called when a file (not a directory) is clicked. */
  onSelectFile: (path: string) => void;
  /** Currently selected file path, for highlighting. */
  selectedPath: string | null;
}

/**
 * Turn the server's flat list of paths (e.g. `src/api/client.ts`) into a nested
 * `TreeNode` map keyed by path segment, synthesizing intermediate directories
 * so the browser can render a collapsible tree.
 */
interface TreeNode {
  name: string;
  path: string;
  kind: TreeEntry["kind"];
  size: number | null;
  children: Map<string, TreeNode>;
}

function buildTree(entries: TreeEntry[]): Map<string, TreeNode> {
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

function TreeNodeRow({
  node,
  depth,
  selectedPath,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isDir = node.kind === "tree";
  const isSelected = node.path === selectedPath;

  return (
    <div>
      <div
        className={[
          "flex items-center gap-1 px-2 py-0.5 rounded cursor-pointer text-sm",
          "hover:bg-[#21262d] transition-colors",
          isSelected ? "bg-[#1f3a5f] text-blue-300" : "text-[#e6edf3]",
        ].join(" ")}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => {
          if (isDir) {
            setOpen((o) => !o);
          } else {
            onSelectFile(node.path);
          }
        }}
      >
        {isDir ? (
          <ChevronRight
            size={12}
            className={`text-[#8b949e] transition-transform ${open ? "rotate-90" : ""}`}
          />
        ) : (
          <span className="w-3" />
        )}
        {isDir ? (
          <Folder size={14} className="text-blue-400 shrink-0" />
        ) : (
          <FileText size={14} className="text-[#8b949e] shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
        {!isDir && node.size != null && (
          <span className="ml-auto text-xs text-[#8b949e] shrink-0">
            {formatSize(node.size)}
          </span>
        )}
      </div>
      {isDir && open && (
        <div>
          {[...node.children.values()]
            .sort((a, b) => {
              // Directories first
              if (a.kind === "tree" && b.kind !== "tree") return -1;
              if (a.kind !== "tree" && b.kind === "tree") return 1;
              return a.name.localeCompare(b.name);
            })
            .map((child) => (
              <TreeNodeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Recursive file-tree browser for a commit. Builds a nested tree from the flat
 * entry list and renders collapsible directories (auto-expanded to depth 2);
 * clicking a file calls `onSelectFile`.
 */
export default function FileBrowser({
  entries,
  onSelectFile,
  selectedPath,
}: FileBrowserProps) {
  const tree = buildTree(entries);

  return (
    <div className="h-full overflow-auto py-2 font-mono text-xs">
      {[...tree.values()]
        .sort((a, b) => {
          if (a.kind === "tree" && b.kind !== "tree") return -1;
          if (a.kind !== "tree" && b.kind === "tree") return 1;
          return a.name.localeCompare(b.name);
        })
        .map((node) => (
          <TreeNodeRow
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
          />
        ))}
    </div>
  );
}
