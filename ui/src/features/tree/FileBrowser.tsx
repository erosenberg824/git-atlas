import { useState } from "react";
import { FileText, Folder, ChevronRight } from "lucide-react";
import type { TreeEntry } from "../../api/client";
import {
  buildTree,
  formatSize,
  sortedTreeNodes,
  type TreeNode,
} from "./fileTree";

interface FileBrowserProps {
  /** Flat list of tree entries (files + dirs) for a commit, from GET /tree/:oid. */
  entries: TreeEntry[];
  /** Called when a file (not a directory) is clicked. */
  onSelectFile: (path: string) => void;
  /** Currently selected file path, for highlighting. */
  selectedPath: string | null;
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
          {sortedTreeNodes(node.children).map((child) => (
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
      {sortedTreeNodes(tree).map((node) => (
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
