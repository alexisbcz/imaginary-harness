import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { PatchDiff } from "@pierre/diffs/react";
import { IconClockArrow } from "@pierre/icons";
import { cn } from "cn";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

type Version = { sha: string; message: string; author: string; date: string };
type FileDiff = {
  path: string;
  raw: string;
  additions: number;
  deletions: number;
};

/** A diff as `PatchDiff` reads it: a unified patch with file headers. */
function patchOf(file: FileDiff) {
  if (/^--- /m.test(file.raw)) return file.raw;
  return `--- a/${file.path}\n+++ b/${file.path}\n${file.raw}`;
}

/** Every version of the project, newest first: what each changed, and a way back to any of them. */
export function HistoryPanel({
  threadId,
  revision,
}: {
  threadId: string;
  /** Changes whenever the project does, to reload the list. */
  revision: string;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff[] | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api<{ versions: Version[] }>(`/api/projects/${threadId}/history`)
      .then((result) => active && setVersions(result.versions))
      .catch((error) => active && setError(String(error.message ?? error)));
    return () => {
      active = false;
    };
  }, [threadId, revision]);

  const current = selected ?? versions?.[0]?.sha ?? null;
  useEffect(() => {
    if (!current) return;
    let active = true;
    setDiff(null);
    api<{ files: FileDiff[] }>(`/api/projects/${threadId}/history/${current}`)
      .then((result) => active && setDiff(result.files))
      .catch(() => active && setDiff([]));
    return () => {
      active = false;
    };
  }, [threadId, current]);

  async function restore(sha: string) {
    setRestoring(true);
    setError(null);
    try {
      await api(`/api/projects/${threadId}/restore`, { body: { sha } });
      setSelected(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not restore");
    } finally {
      setRestoring(false);
    }
  }

  if (versions === null)
    return (
      <div className="flex flex-col gap-3 p-4">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );

  if (versions.length === 0)
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {error ?? "No versions yet"}
      </div>
    );

  return (
    <div className="flex h-full min-h-0">
      <ol className="w-64 shrink-0 overflow-y-auto border-r p-2">
        {versions.map((version, index) => (
          <li key={version.sha}>
            <button
              type="button"
              onClick={() => setSelected(version.sha)}
              className={cn(
                "flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted",
                version.sha === current && "bg-muted",
              )}
            >
              <span className="line-clamp-2">{version.message}</span>
              <span className="text-xs text-muted-foreground">
                {index === 0 ? "Current · " : ""}
                {version.author} ·{" "}
                {formatDistanceToNow(new Date(version.date), {
                  addSuffix: true,
                })}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {current?.slice(0, 7)}
            {diff && ` · ${diff.length} file${diff.length === 1 ? "" : "s"}`}
          </span>
          {error && <span className="text-xs text-destructive">{error}</span>}
          {current && current !== versions[0]!.sha && (
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button size="sm" variant="outline" disabled={restoring} />
                }
              >
                {restoring ? <Spinner /> : <IconClockArrow />}
                Restore this version
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Restore this version?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Every file goes back to how it was at this version. The
                    restore is a new version on top, so you can undo it the same
                    way.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void restore(current)}>
                    Restore
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto text-[13px]">
          {diff === null ? (
            <div className="flex h-full items-center justify-center">
              <Spinner className="text-muted-foreground" />
            </div>
          ) : (
            diff.map((file) => (
              <div key={file.path} className="border-b">
                <PatchDiff
                  patch={patchOf(file)}
                  options={{
                    themeType: "light",
                    overflow: "scroll",
                    diffStyle: "unified",
                  }}
                />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
