import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { MultiFileDiff } from "@pierre/diffs/react";
import { IconDiffUnified, IconFile } from "@pierre/icons";
import pierreLight from "@pierre/theme/pierre-light";
import { themeToTreeStyles } from "@pierre/trees";
import {
  FileTree,
  useFileTree,
  useFileTreeSelection,
} from "@pierre/trees/react";

import type { WorkspaceFile } from "@/components/workspace";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";

const treeStyles = themeToTreeStyles(pierreLight);

function languageOf(path: string) {
  if (/\.(tsx?|jsx?|mjs|cjs)$/.test(path))
    return [javascript({ jsx: true, typescript: /\.tsx?$/.test(path) })];
  if (path.endsWith(".css")) return [css()];
  if (path.endsWith(".html")) return [html()];
  if (path.endsWith(".json")) return [json()];
  if (path.endsWith(".md")) return [markdown()];
  return [];
}

/** The project's code: the tree to pick a file, an editor to change it by hand (each save is a commit). */
export function CodePanel({
  threadId,
  files,
}: {
  threadId: string;
  files: WorkspaceFile[];
}) {
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const { model } = useFileTree({ paths, flattenEmptyDirectories: true });
  const selection = useFileTreeSelection(model);
  useEffect(() => model.resetPaths(paths), [model, paths]);

  // Without a choice of the user's, show the file changed last.
  const latest = useMemo(
    () =>
      files.reduce<WorkspaceFile | undefined>(
        (a, b) => (a === undefined || b.updated_at > a.updated_at ? b : a),
        undefined,
      ),
    [files],
  );
  const selected = files.find((file) => file.path === selection[0]) ?? latest;

  const [draft, setDraft] = useState<string | null>(null);
  const [view, setView] = useState<"code" | "diff">("code");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== null && draft !== selected?.contents;

  // A new file, or the agent changing this one, replaces an unchanged draft.
  useEffect(() => {
    setDraft(null);
    setError(null);
  }, [selected?.path]);

  async function save() {
    if (!selected || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/projects/${threadId}/files`, {
        method: "PUT",
        body: { path: selected.path, contents: draft },
      });
      setDraft(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  const canDiff = selected?.previous != null && !dirty;
  const showDiff = view === "diff" && canDiff;

  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 shrink-0 border-r">
        <FileTree model={model} style={{ ...treeStyles, height: "100%" }} />
      </div>
      {selected ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {selected.path}
              {dirty && " •"}
            </span>
            {error && <span className="text-xs text-destructive">{error}</span>}
            {dirty && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraft(null)}
                >
                  Discard
                </Button>
                <Button size="sm" disabled={saving} onClick={() => void save()}>
                  Save <Kbd>⌘S</Kbd>
                </Button>
              </>
            )}
            <ToggleGroup
              size="sm"
              value={[showDiff ? "diff" : "code"]}
              onValueChange={(value: unknown[]) => {
                if (value[0] === "diff" || value[0] === "code")
                  setView(value[0]);
              }}
            >
              <ToggleGroupItem value="code" aria-label="Edit the file">
                <IconFile />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="diff"
                aria-label="Its latest change"
                disabled={!canDiff}
              >
                <IconDiffUnified />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div
            className="min-h-0 flex-1 overflow-auto text-[13px]"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                event.preventDefault();
                void save();
              }
            }}
          >
            {showDiff ? (
              <MultiFileDiff
                oldFile={{ name: selected.path, contents: selected.previous! }}
                newFile={{ name: selected.path, contents: selected.contents }}
                options={{
                  themeType: "light",
                  overflow: "scroll",
                  diffStyle: "unified",
                }}
              />
            ) : (
              <CodeMirror
                key={selected.path}
                value={draft ?? selected.contents}
                extensions={languageOf(selected.path)}
                onChange={setDraft}
                height="100%"
                className="h-full"
                basicSetup={{ foldGutter: false }}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No files yet
        </div>
      )}
    </div>
  );
}
