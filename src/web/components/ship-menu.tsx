import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import { LightIconButton } from "twenty-ui/components/input";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button, Input, InputGroup } from "twenty-ui/primitives/input";
import { Popover } from "twenty-ui/primitives/surfaces";
import {
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconGitBranch,
  IconWorld,
} from "twenty-ui/icon";

import { api } from "@/lib/api";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <LightIconButton
      aria-label={`Copy the ${label.toLowerCase()}`}
      tooltip={copied ? "Copied" : "Copy"}
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </LightIconButton>
  );
}

/** A popover anchored under a header button, laid out like Twenty's dropdown panels. */
function Panel({
  trigger,
  title,
  description,
  width,
  onOpenChange,
  children,
}: {
  trigger: ReactElement;
  title: ReactNode;
  description: ReactNode;
  width: number;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Popover.Root onOpenChange={onOpenChange}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6}>
          <Popover.Popup
            className="flex flex-col overflow-hidden rounded-md border border-t-border bg-t-primary shadow-[0_0_4px_rgb(0_0_0/0.04),0_4px_16px_rgb(0_0_0/0.08)] outline-none"
            style={{ width }}
          >
            <div className="flex flex-col gap-1 px-3 pt-3 pb-2">
              <Popover.Title className="font-semibold text-t-text">
                {title}
              </Popover.Title>
              <Popover.Description className="leading-[1.45] text-t-text-tertiary">
                {description}
              </Popover.Description>
            </div>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Publishing: build the app and put it online, update it, or take it down. */
export function PublishButton({
  threadId,
  disabled,
}: {
  threadId: string;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<{
    url: string | null;
    publishedAt: string | null;
  } | null>(null);
  const [working, setWorking] = useState<"publish" | "unpublish" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStatus(null);
    api<{ url: string | null; publishedAt: string | null }>(
      `/api/projects/${threadId}/publish`,
    )
      .then(setStatus)
      .catch(() => setStatus({ url: null, publishedAt: null }));
  }, [threadId]);

  async function publish() {
    setWorking("publish");
    setError(null);
    try {
      const result = await api<{ url: string }>(
        `/api/projects/${threadId}/publish`,
        { method: "POST" },
      );
      setStatus({ url: result.url, publishedAt: new Date().toISOString() });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not publish");
    } finally {
      setWorking(null);
    }
  }

  async function unpublish() {
    setWorking("unpublish");
    setError(null);
    try {
      await api(`/api/projects/${threadId}/publish`, { method: "DELETE" });
      setStatus({ url: null, publishedAt: null });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not unpublish");
    } finally {
      setWorking(null);
    }
  }

  const published = Boolean(status?.url);
  return (
    <Panel
      width={360}
      title={published ? "Your app is online" : "Publish your app"}
      description={
        published
          ? `Published ${formatDistanceToNow(new Date(status!.publishedAt!), { addSuffix: true })}. Publish again to put your latest changes online.`
          : "Build the app and put it online at its own address, for anyone with the link."
      }
      trigger={
        <Button
          size="sm"
          variant="solid"
          color="accent"
          disabled={disabled}
          startIcon={<IconWorld size={14} />}
        >
          {published ? "Published" : "Publish"}
        </Button>
      }
    >
      {published && (
        <div className="px-3 pb-2">
          <InputGroup
            size="sm"
            startElement={
              <span
                aria-hidden
                className="ml-1 size-2 rounded-full"
                style={{ background: "var(--t-color-green9)" }}
              />
            }
            endElement={
              <div className="flex items-center">
                <CopyButton value={status!.url!} label="Address" />
                <LightIconButton
                  aria-label="Open the published app"
                  tooltip="Open"
                  size="sm"
                  onClick={() =>
                    window.open(status!.url!, "_blank", "noopener")
                  }
                >
                  <IconExternalLink size={14} />
                </LightIconButton>
              </div>
            }
          >
            <Input
              readOnly
              aria-label="Address"
              value={status!.url!}
              className="font-mono"
              onFocus={(event) => event.target.select()}
            />
          </InputGroup>
        </div>
      )}
      {error && (
        <p className="mx-3 mb-2 max-h-40 overflow-auto rounded-sm bg-[var(--t-background-danger)] p-2 font-mono text-[11px] whitespace-pre-wrap text-t-text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-t-border-light bg-t-secondary px-3 py-2">
        {published && (
          <Button
            variant="ghost"
            size="sm"
            disabled={working !== null}
            loading={working === "unpublish"}
            onClick={() => void unpublish()}
          >
            Unpublish
          </Button>
        )}
        <Button
          size="sm"
          variant="solid"
          color="accent"
          disabled={working !== null || status === null}
          loading={working === "publish"}
          loadingPosition="start"
          onClick={() => void publish()}
        >
          {working === "publish"
            ? "Building…"
            : published
              ? "Publish changes"
              : "Publish"}
        </Button>
      </div>
    </Panel>
  );
}

/** The project's code as a git repository: a read-only clone command with a token that expires within the hour. */
export function CloneButton({
  threadId,
  disabled,
}: {
  threadId: string;
  disabled: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel
      width={440}
      title="Clone the code"
      description="Every change is a commit in this project's git repository. The link can read it for an hour."
      onOpenChange={(open) => {
        if (!open) return;
        setUrl(null);
        setError(null);
        api<{ url: string }>(`/api/projects/${threadId}/clone`)
          .then((result) => setUrl(result.url))
          .catch((error) => setError(error.message));
      }}
      trigger={
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          startIcon={<IconGitBranch size={14} />}
        >
          Clone
        </Button>
      }
    >
      <div className="px-3 pb-3">
        {url ? (
          <div className="flex h-8 items-center gap-1 rounded-sm border border-t-border-light bg-t-secondary pr-1 pl-2.5 font-mono text-[12px]">
            <span className="shrink-0 text-t-text-light">$</span>
            <span className="min-w-0 flex-1 truncate text-t-text-secondary">
              git clone {url} app
            </span>
            <CopyButton value={`git clone ${url} app`} label="Clone command" />
          </div>
        ) : error ? (
          <p className="text-t-text-danger">{error}</p>
        ) : (
          <div className="flex h-9 items-center">
            <Loader />
          </div>
        )}
      </div>
    </Panel>
  );
}
