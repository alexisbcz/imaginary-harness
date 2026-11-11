import { useEffect, useMemo, useState } from "react"
import { File, MultiFileDiff } from "@pierre/diffs/react"
import { IconDiffUnified, IconFile } from "@pierre/icons"
import pierreLight from "@pierre/theme/pierre-light"
import { themeToTreeStyles, type GitStatusEntry } from "@pierre/trees"
import { FileTree, useFileTree, useFileTreeSelection } from "@pierre/trees/react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { createClient } from "@/lib/supabase/client"

const supabase = createClient()

export type WorkspaceFile = {
  path: string
  contents: string
  previous: string | null
  updated_at: string
}

/** A thread's workspace files, kept current through Realtime as the agent writes them. */
export function useWorkspaceFiles(threadId: string) {
  const [files, setFiles] = useState<WorkspaceFile[]>([])

  useEffect(() => {
    let active = true
    setFiles([])
    const load = async () => {
      const { data } = await supabase
        .from("files")
        .select("path, contents, previous, updated_at")
        .eq("thread_id", threadId)
        .order("path")
      if (active && data) setFiles(data)
    }
    const channel = supabase
      .channel(`files:${threadId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "files", filter: `thread_id=eq.${threadId}` },
        () => void load()
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void load()
      })
    void load()
    return () => {
      active = false
      void supabase.removeChannel(channel)
    }
  }, [threadId])

  return files
}

const treeStyles = themeToTreeStyles(pierreLight)
const CODE_OPTIONS = { themeType: "light", overflow: "scroll", stickyHeader: true } as const

/** The agent's files: Pierre's tree to pick one, Pierre's diffs to read it or its latest change. */
export function Workspace({ files }: { files: WorkspaceFile[] }) {
  const paths = useMemo(() => files.map((file) => file.path), [files])
  // A file the latest change created is "added", one changed since is "modified".
  const gitStatus = useMemo<GitStatusEntry[]>(
    () => files.map((file) => ({ path: file.path, status: file.previous === null ? "added" : "modified" })),
    [files]
  )
  const { model } = useFileTree({ paths, gitStatus, initialExpansion: "open", flattenEmptyDirectories: true })
  const selection = useFileTreeSelection(model)
  const [view, setView] = useState<"diff" | "file">("diff")

  useEffect(() => {
    model.resetPaths(paths)
    model.setGitStatus(gitStatus)
  }, [model, paths, gitStatus])

  // Without a choice of the user's, show the file the agent changed last.
  const latest = useMemo(
    () => files.reduce<WorkspaceFile | undefined>((a, b) => (a === undefined || b.updated_at > a.updated_at ? b : a), undefined),
    [files]
  )
  const selected = files.find((file) => file.path === selection[0]) ?? latest
  const showDiff = view === "diff" && selected?.previous != null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="h-44 shrink-0 border-b">
        <FileTree model={model} style={{ ...treeStyles, height: "100%" }} />
      </div>
      {selected && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center justify-end border-b px-3">
            <ToggleGroup
              size="sm"
              value={[showDiff ? "diff" : "file"]}
              onValueChange={(value: unknown[]) => {
                if (value[0] === "diff" || value[0] === "file") setView(value[0])
              }}
            >
              <ToggleGroupItem value="diff" aria-label="Latest change" disabled={selected.previous === null}>
                <IconDiffUnified />
              </ToggleGroupItem>
              <ToggleGroupItem value="file" aria-label="Whole file">
                <IconFile />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="min-h-0 flex-1 overflow-auto text-[13px]">
            {showDiff ? (
              <MultiFileDiff
                oldFile={{ name: selected.path, contents: selected.previous! }}
                newFile={{ name: selected.path, contents: selected.contents }}
                options={{ ...CODE_OPTIONS, diffStyle: "unified" }}
              />
            ) : (
              <File file={{ name: selected.path, contents: selected.contents }} options={CODE_OPTIONS} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
