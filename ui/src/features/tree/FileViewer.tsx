import { useEffect, useState } from "react";
import { Loader2, FileText } from "lucide-react";
import { api, type BlobResponse } from "../../api/client";
import Tooltip from "../../components/Tooltip";

/**
 * Displays the contents of a file (blob) at a given commit. Used by the Files
 * tab: clicking a file shows its contents here (as opposed to the commit
 * panel's changed-file click, which shows a diff).
 */
export default function FileViewer({ oid, path }: { oid: string; path: string }) {
  const [blob, setBlob] = useState<BlobResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setBlob(null);
    api.tree
      .blob(oid, path)
      .then(setBlob)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load file"))
      .finally(() => setLoading(false));
  }, [oid, path]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[#8b949e]">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-red-400">{error}</div>
    );
  }
  if (!blob) return null;

  return (
    <div className="flex flex-col h-full">
      {/* File header */}
      <div className="flex items-center gap-2 px-3 h-8 border-b border-[#30363d] bg-[#161b22] shrink-0">
        <FileText size={13} className="text-[#8b949e]" />
        <Tooltip primary={blob.path} mono className="min-w-0">
          <span className="text-xs font-mono text-[#e6edf3] truncate">
            {blob.path}
          </span>
        </Tooltip>
        <span className="text-[10px] text-[#6e7681] ml-auto shrink-0">{blob.size} bytes</span>
      </div>

      {/* Contents */}
      <div className="flex-1 min-h-0 overflow-auto">
        {blob.is_binary ? (
          <div className="flex items-center justify-center h-full text-sm text-[#8b949e] italic">
            Binary file ({blob.size} bytes) — not shown
          </div>
        ) : (
          <pre className="text-xs font-mono leading-5 p-3 text-[#e6edf3] whitespace-pre">
            {blob.content}
          </pre>
        )}
      </div>
    </div>
  );
}
