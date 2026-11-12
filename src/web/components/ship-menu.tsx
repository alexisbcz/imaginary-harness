import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "react-i18next";
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
import { dateLocale } from "@/lib/i18n";

/** `label` names the action in full, e.g. "Copy the address". */
function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation("common");
  const [copied, setCopied] = useState(false);
  return (
    <LightIconButton
      aria-label={label}
      tooltip={copied ? t("copied") : t("copy")}
      size="sm"
      onClick={() => {
        // Only confirm a copy that happened: the browser can refuse clipboard access.
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
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
  projectId,
  disabled,
}: {
  projectId: string;
  disabled: boolean;
}) {
  const { t } = useTranslation("builder");
  const { t: tc } = useTranslation("common");
  const [status, setStatus] = useState<{
    url: string | null;
    publishedAt: string | null;
  } | null>(null);
  const [working, setWorking] = useState<"publish" | "unpublish" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStatus(null);
    api<{ url: string | null; publishedAt: string | null }>(
      `/api/projects/${projectId}/publish`,
    )
      .then(setStatus)
      .catch(() => setStatus({ url: null, publishedAt: null }));
  }, [projectId]);

  async function publish() {
    setWorking("publish");
    setError(null);
    try {
      const result = await api<{ url: string }>(
        `/api/projects/${projectId}/publish`,
        { method: "POST" },
      );
      setStatus({ url: result.url, publishedAt: new Date().toISOString() });
    } catch (error) {
      setError(error instanceof Error ? error.message : t("ship.publishFailed"));
    } finally {
      setWorking(null);
    }
  }

  async function unpublish() {
    setWorking("unpublish");
    setError(null);
    try {
      await api(`/api/projects/${projectId}/publish`, { method: "DELETE" });
      setStatus({ url: null, publishedAt: null });
    } catch (error) {
      setError(error instanceof Error ? error.message : t("ship.unpublishFailed"));
    } finally {
      setWorking(null);
    }
  }

  const published = Boolean(status?.url);
  return (
    <Panel
      width={360}
      title={published ? t("ship.onlineTitle") : t("ship.publishTitle")}
      description={
        published
          ? t("ship.onlineBody", {
              when: formatDistanceToNow(new Date(status!.publishedAt!), {
                addSuffix: true,
                locale: dateLocale(),
              }),
            })
          : t("ship.publishBody")
      }
      trigger={
        <Button
          size="sm"
          variant="solid"
          color="accent"
          disabled={disabled}
          startIcon={<IconWorld size={14} />}
        >
          {published ? t("ship.published") : t("ship.publish")}
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
                <CopyButton value={status!.url!} label={t("ship.copyAddress")} />
                <LightIconButton
                  aria-label={t("ship.openApp")}
                  tooltip={tc("open")}
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
              aria-label={t("ship.address")}
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
            {t("ship.unpublish")}
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
            ? t("ship.building")
            : published
              ? t("ship.publishChanges")
              : t("ship.publish")}
        </Button>
      </div>
    </Panel>
  );
}

/** The project's code as a git repository: a read-only clone command with a token that expires within the hour. */
export function CloneButton({
  projectId,
  disabled,
}: {
  projectId: string;
  disabled: boolean;
}) {
  const { t } = useTranslation("builder");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel
      width={440}
      title={t("ship.cloneTitle")}
      description={t("ship.cloneBody")}
      onOpenChange={(open) => {
        if (!open) return;
        setUrl(null);
        setError(null);
        api<{ url: string }>(`/api/projects/${projectId}/clone`)
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
          {t("ship.clone")}
        </Button>
      }
    >
      <div className="px-3 pb-3">
        {url ? (
          <div className="flex h-8 items-center gap-1 rounded-sm border border-t-border-light bg-t-secondary pr-1 pl-2.5 font-mono text-[12px]">
            <span className="shrink-0 text-t-text-light">$</span>
            <span className="min-w-0 flex-1 truncate text-t-text-secondary">
              {/* i18n-ignore: a shell command */}
              git clone {url} app
            </span>
            <CopyButton value={`git clone ${url} app`} label={t("ship.copyClone")} />
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
