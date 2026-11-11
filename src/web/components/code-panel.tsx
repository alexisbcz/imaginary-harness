import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { MultiFileDiff } from "@pierre/diffs/react";
import { SegmentedControl } from "twenty-ui/components/input";
import { Button } from "twenty-ui/primitives/input";
import { IconCode, IconFileDiff } from "@tabler/icons-react";
import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";
import { themeToTreeStyles } from "@pierre/trees";
import {
  FileTree,
  useFileTree,
  useFileTreeSelection,
} from "@pierre/trees/react";

import type { WorkspaceFile } from "@/components/workspace";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { api } from "@/lib/api";

const treeStyles = {
  light: themeToTreeStyles(pierreLight),
  dark: themeToTreeStyles(pierreDark),
};

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
  const scheme = useColorScheme();
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
        <FileTree
          model={model}
          style={{ ...treeStyles[scheme], height: "100%" }}
        />
      </div>
      {selected ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-t-border-light px-3">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-t-text-tertiary">
              {selected.path}
              {dirty && " •"}
            </span>
            {error && <span className="text-t-text-danger">{error}</span>}
            {dirty && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraft(null)}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  variant="solid"
                  color="accent"
                  loading={saving}
                  shortcut={["⌘", "S"]}
                  onClick={() => void save()}
                >
                  Save
                </Button>
              </>
            )}
            <SegmentedControl<"code" | "diff">
              aria-label="View"
              size="sm"
              value={showDiff ? "diff" : "code"}
              onValueChange={(value) => setView(value)}
              options={[
                {
                  value: "code",
                  startIcon: <IconCode size={14} />,
                  "aria-label": "Edit the file",
                },
                {
                  value: "diff",
                  startIcon: <IconFileDiff size={14} />,
                  "aria-label": "Its latest change",
                  disabled: !canDiff,
                },
              ]}
            />
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
                  themeType: scheme,
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
                theme={scheme}
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
