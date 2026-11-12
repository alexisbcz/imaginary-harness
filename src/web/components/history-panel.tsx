import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "react-i18next";
import { PatchDiff } from "@pierre/diffs/react";
import { Skeleton } from "twenty-ui/primitives/feedback";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button } from "twenty-ui/primitives/input";
import { AlertDialog } from "twenty-ui/primitives/surfaces";
import { IconRestore } from "twenty-ui/icon";
import { cn } from "cn";

import { api } from "@/lib/api";
import { dateLocale } from "@/lib/i18n";

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
  const { t } = useTranslation("builder");
  const { t: tc } = useTranslation("common");
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
      setError(error instanceof Error ? error.message : t("history.restoreFailed"));
    } finally {
      setRestoring(false);
    }
  }

  if (versions === null)
    return (
      <div className="flex w-64 flex-col gap-4 p-4">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton width={`${60 + ((i * 23) % 35)}%`} height={10} />
            <Skeleton width="40%" height={8} />
          </div>
        ))}
      </div>
    );

  if (versions.length === 0)
    return (
      <div className="flex h-full items-center justify-center text-t-text-tertiary">
        {error ?? t("history.empty")}
      </div>
    );

  return (
    <div className="flex h-full min-h-0">
      <ol className="flex w-64 shrink-0 flex-col gap-px overflow-y-auto border-r border-t-border-light p-2">
        {versions.map((version, index) => (
          <li key={version.sha}>
            <button
              type="button"
              onClick={() => setSelected(version.sha)}
              className={cn(
                "flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-t-hover focus-visible:ring-2 focus-visible:ring-ring",
                version.sha === current && "bg-t-press",
              )}
            >
              <span className="line-clamp-2 text-t-text">
                {version.message}
              </span>
              <span className="text-[12px] text-t-text-tertiary">
                {index === 0 ? `${t("history.current")} · ` : ""}
                {version.author} ·{" "}
                {formatDistanceToNow(new Date(version.date), {
                  addSuffix: true,
                  locale: dateLocale(),
                })}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-t-border-light px-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-t-text-tertiary">
            {current?.slice(0, 7)}
            {diff && ` · ${t("history.files", { count: diff.length })}`}
          </span>
          {error && <span className="text-t-text-danger">{error}</span>}
          {current && current !== versions[0]!.sha && (
            <AlertDialog.Root>
              <AlertDialog.Trigger
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    loading={restoring}
                    loadingPosition="start"
                    startIcon={<IconRestore size={14} />}
                  />
                }
              >
                {t("history.restoreThis")}
              </AlertDialog.Trigger>
              <AlertDialog.Portal>
                <AlertDialog.Backdrop />
                <AlertDialog.Viewport>
                  <AlertDialog.Popup size="sm">
                    <AlertDialog.Header>
                      <AlertDialog.Title>
                        {t("history.confirmTitle")}
                      </AlertDialog.Title>
                    </AlertDialog.Header>
                    <AlertDialog.Body>
                      <AlertDialog.Description>
                        {t("history.confirmBody")}
                      </AlertDialog.Description>
                    </AlertDialog.Body>
                    <AlertDialog.Footer>
                      <AlertDialog.Close render={<Button variant="outline" />}>
                        {tc("cancel")}
                      </AlertDialog.Close>
                      <AlertDialog.Close
                        render={<Button variant="solid" color="accent" />}
                        onClick={() => void restore(current)}
                      >
                        {t("history.restore")}
                      </AlertDialog.Close>
                    </AlertDialog.Footer>
                  </AlertDialog.Popup>
                </AlertDialog.Viewport>
              </AlertDialog.Portal>
            </AlertDialog.Root>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto text-[13px]">
          {diff === null ? (
            <div className="flex h-full items-center justify-center">
              <Loader />
            </div>
          ) : (
            diff.map((file) => (
              <div key={file.path} className="border-b border-t-border-light">
                <PatchDiff
                  patch={patchOf(file)}
                  options={{
                    themeType: "system",
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
