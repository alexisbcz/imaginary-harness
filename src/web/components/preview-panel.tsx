import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconArrowUpRight,
  IconCursor,
  IconDesktop,
  IconPhone,
  IconRefresh,
  IconReload,
  IconTablet,
  IconWarningOctogonFill,
  IconX,
} from "@pierre/icons";
import { cn } from "cn";

import { Shimmer } from "@/components/ai-elements/shimmer";
import type { PickedElement } from "@/components/composer";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";

type Status =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "running"; url: string }
  | { state: "failed"; error: string };

type Device = "desktop" | "tablet" | "phone";
const DEVICE_WIDTHS: Record<Device, number | undefined> = {
  desktop: undefined,
  tablet: 768,
  phone: 390,
};
/** How often the panel checks the preview still runs at the same address (a restart can move it). */
const STATUS_POLL_MS = 5_000;

type PreviewError = { message: string; stack?: string };

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The project's app, running live in its dev server, with the tools to look at it and point at its parts. */
export function PreviewPanel({
  threadId,
  hasFiles,
  busy,
  onPicked,
  onFix,
}: {
  threadId: string;
  hasFiles: boolean;
  /** The agent is answering: errors are likely mid-change, so fixing waits. */
  busy: boolean;
  onPicked: (element: PickedElement) => void;
  onFix: (errors: PreviewError[]) => void;
}) {
  const [status, setStatus] = useState<Status>({ state: "stopped" });
  const [path, setPath] = useState("/");
  const [address, setAddress] = useState("/");
  const [device, setDevice] = useState<Device>("desktop");
  const [reloads, setReloads] = useState(0);
  const [picking, setPicking] = useState(false);
  const [errors, setErrors] = useState<PreviewError[]>([]);
  const frame = useRef<HTMLIFrameElement>(null);
  const url = status.state === "running" ? status.url : undefined;

  const start = useCallback(
    async (restart = false) => {
      setStatus({ state: "starting" });
      try {
        const result = await api<{ url: string }>(
          `/api/projects/${threadId}/preview${restart ? "/restart" : ""}`,
          { method: "POST" },
        );
        setStatus({ state: "running", url: result.url });
        setErrors([]);
      } catch (error) {
        setStatus({
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [threadId],
  );

  // Start once the project has files: a new one gets them when the agent picks up its first message.
  useEffect(() => {
    setStatus({ state: "stopped" });
    setPath("/");
    setAddress("/");
    setErrors([]);
  }, [threadId]);
  useEffect(() => {
    if (hasFiles && status.state === "stopped") void start();
  }, [hasFiles, status.state, start]);

  // Follow the preview: a restart (new packages) may move it, an idle one stops.
  useEffect(() => {
    if (status.state !== "running") return;
    const timer = setInterval(async () => {
      if (document.hidden) return;
      const current = await api<Status>(
        `/api/projects/${threadId}/preview`,
      ).catch(() => undefined);
      if (!current) return;
      if (current.state === "running" && current.url !== url)
        setStatus(current);
      else if (current.state === "stopped") void start();
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [status.state, threadId, url, start]);

  // Messages from the bridge inside the preview.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string } & Record<
        string,
        unknown
      >;
      if (data?.source !== "richelieu-preview") return;
      switch (data.type) {
        case "error": {
          const error = {
            message: String(data.message),
            stack: typeof data.stack === "string" ? data.stack : undefined,
          };
          setErrors((current) =>
            current.some((e) => e.message === error.message)
              ? current
              : [...current, error].slice(-10),
          );
          void api(`/api/projects/${threadId}/preview/errors`, {
            body: error,
          }).catch(() => {});
          break;
        }
        case "location":
          setPath(String(data.path));
          setAddress(String(data.path));
          break;
        case "picking":
          setPicking(Boolean(data.on));
          break;
        case "picked":
          onPicked({
            loc: String(data.loc),
            tag: String(data.tag),
            text: String(data.text ?? ""),
            className: String(data.className ?? ""),
          });
          break;
        case "ready":
          // A reload starts clean; errors the agent has not fixed come back on their own.
          setErrors([]);
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [threadId, onPicked]);

  function togglePicking() {
    const on = !picking;
    frame.current?.contentWindow?.postMessage(
      { source: "richelieu-builder", type: "pick", on },
      "*",
    );
    setPicking(on);
  }

  function navigate(to: string) {
    const target = to.startsWith("/") ? to : `/${to}`;
    setPath(target);
    setAddress(target);
    setReloads((n) => n + 1);
  }

  const width = DEVICE_WIDTHS[device];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <IconButton
          label="Reload"
          disabled={!url}
          onClick={() => setReloads((n) => n + 1)}
        >
          <IconRefresh />
        </IconButton>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            navigate(address);
          }}
        >
          <Input
            aria-label="Page"
            value={address}
            disabled={!url}
            onChange={(event) => setAddress(event.target.value)}
            className="h-7 rounded-full bg-muted/60 font-mono text-xs"
          />
        </form>
        <ToggleGroup
          size="sm"
          value={[device]}
          onValueChange={(value: unknown[]) => {
            if (
              value[0] === "desktop" ||
              value[0] === "tablet" ||
              value[0] === "phone"
            )
              setDevice(value[0]);
          }}
        >
          <ToggleGroupItem value="desktop" aria-label="Desktop width">
            <IconDesktop />
          </ToggleGroupItem>
          <ToggleGroupItem value="tablet" aria-label="Tablet width">
            <IconTablet />
          </ToggleGroupItem>
          <ToggleGroupItem value="phone" aria-label="Phone width">
            <IconPhone />
          </ToggleGroupItem>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                size="sm"
                aria-label="Pick an element to change"
                pressed={picking}
                disabled={!url}
                onPressedChange={togglePicking}
              />
            }
          >
            <IconCursor />
          </TooltipTrigger>
          <TooltipContent>Pick an element to change</TooltipContent>
        </Tooltip>
        <IconButton
          label="Open in a new tab"
          disabled={!url}
          onClick={() => url && window.open(url + path, "_blank", "noopener")}
        >
          <IconArrowUpRight />
        </IconButton>
        <IconButton
          label="Restart the dev server"
          disabled={status.state === "starting" || !hasFiles}
          onClick={() => void start(true)}
        >
          <IconReload />
        </IconButton>
      </div>

      <div className="relative flex min-h-0 flex-1 justify-center overflow-auto bg-muted/40">
        {url ? (
          <iframe
            key={`${url}:${reloads}`}
            ref={frame}
            title="Preview"
            src={url + path}
            className={cn(
              "h-full bg-background",
              width ? "my-3 rounded-xl border shadow-sm" : "w-full",
            )}
            style={width ? { width, height: "calc(100% - 1.5rem)" } : undefined}
          />
        ) : status.state === "failed" ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>The preview did not start</EmptyTitle>
              <EmptyDescription className="max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap">
                {status.error}
              </EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" onClick={() => void start()}>
              Try again
            </Button>
          </Empty>
        ) : hasFiles ? (
          <div className="flex items-center">
            <Shimmer>Starting the preview…</Shimmer>
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Your app shows here</EmptyTitle>
              <EmptyDescription>
                It runs live as Richelieu builds it, and updates with each
                change.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {errors.length > 0 && (
          <div className="absolute inset-x-3 bottom-3 flex items-start gap-3 rounded-xl border bg-background p-3 text-sm shadow-lg">
            <IconWarningOctogonFill className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {errors.length === 1
                  ? "The app hit an error"
                  : `The app hit ${errors.length} errors`}
              </p>
              <p className="line-clamp-2 font-mono text-xs text-muted-foreground">
                {errors.at(-1)!.message}
              </p>
            </div>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                onFix(errors);
                setErrors([]);
              }}
            >
              Fix it
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss the errors"
              onClick={() => setErrors([])}
            >
              <IconX />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
