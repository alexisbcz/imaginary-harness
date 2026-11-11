import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  IconArrowUpRight,
  IconBrandGit,
  IconCheck,
  IconCopy,
  IconGlobe,
} from "@pierre/icons";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <Input
        readOnly
        aria-label={label}
        value={value}
        className="h-8 font-mono text-xs"
        onFocus={(event) => event.target.select()}
      />
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={`Copy the ${label.toLowerCase()}`}
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </Button>
    </div>
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
    <Popover>
      <PopoverTrigger render={<Button size="sm" disabled={disabled} />}>
        <IconGlobe />
        {published ? "Published" : "Publish"}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <PopoverHeader>
          <PopoverTitle>
            {published ? "Your app is online" : "Publish your app"}
          </PopoverTitle>
          <PopoverDescription>
            {published
              ? `Published ${formatDistanceToNow(new Date(status!.publishedAt!), { addSuffix: true })}. Publish again to put your latest changes online.`
              : "Build the app and put it online at its own address, for anyone with the link."}
          </PopoverDescription>
        </PopoverHeader>
        {published && (
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <CopyField value={status!.url!} label="Address" />
            </div>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Open the published app"
              onClick={() => window.open(status!.url!, "_blank", "noopener")}
            >
              <IconArrowUpRight />
            </Button>
          </div>
        )}
        {error && (
          <p className="max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          {published && (
            <Button
              variant="ghost"
              size="sm"
              disabled={working !== null}
              onClick={() => void unpublish()}
            >
              {working === "unpublish" && <Spinner />}
              Unpublish
            </Button>
          )}
          <Button
            size="sm"
            disabled={working !== null || status === null}
            onClick={() => void publish()}
          >
            {working === "publish" && <Spinner />}
            {working === "publish"
              ? "Building…"
              : published
                ? "Publish changes"
                : "Publish"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
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
    <Popover
      onOpenChange={(open) => {
        if (!open) return;
        setUrl(null);
        setError(null);
        api<{ url: string }>(`/api/projects/${threadId}/clone`)
          .then((result) => setUrl(result.url))
          .catch((error) => setError(error.message));
      }}
    >
      <PopoverTrigger
        render={<Button size="sm" variant="outline" disabled={disabled} />}
      >
        <IconBrandGit />
        Clone
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[28rem]">
        <PopoverHeader>
          <PopoverTitle>Clone the code</PopoverTitle>
          <PopoverDescription>
            Every change is a commit in this project's git repository. The link
            can read it for an hour.
          </PopoverDescription>
        </PopoverHeader>
        {url ? (
          <CopyField value={`git clone ${url} app`} label="Clone command" />
        ) : error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : (
          <Spinner className="text-muted-foreground" />
        )}
      </PopoverContent>
    </Popover>
  );
}
