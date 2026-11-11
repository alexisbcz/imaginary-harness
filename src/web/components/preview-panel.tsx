import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { LightIconButton, SegmentedControl } from "twenty-ui/components/input";
import { Button, Input, InputGroup } from "twenty-ui/primitives/input";
// Twenty UI's icons are Tabler's; it does not re-export these two.
import {
  IconDeviceMobile,
  IconDeviceTablet,
  IconLayoutFilled,
} from "@tabler/icons-react";
import {
  IconAlertTriangle,
  IconClick,
  IconDeviceDesktop,
  IconExternalLink,
  IconRefresh,
  IconReload,
  IconX,
} from "twenty-ui/icon";

import { Shimmer } from "@/components/ai-elements/shimmer";
import type { PickedElement } from "@/components/composer";
import { IconTile } from "@/components/icon-tile";
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

/** An empty or failed preview: a title and a line of explanation, centered, like Twenty's empty states. */
function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 self-center px-6 text-center">
      <IconTile size="lg" color="blue">
        <IconLayoutFilled />
      </IconTile>
      <div className="flex flex-col gap-1">
        <p className="font-semibold text-t-text">{title}</p>
        <div className="leading-[1.45] text-t-text-tertiary">{children}</div>
      </div>
      {action}
    </div>
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
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-t-border-light px-2">
        <LightIconButton
          aria-label="Reload"
          tooltip="Reload"
          disabled={!url}
          onClick={() => setReloads((n) => n + 1)}
        >
          <IconRefresh size={16} />
        </LightIconButton>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            navigate(address);
          }}
        >
          <InputGroup
            size="sm"
            startElement={
              <span
                aria-hidden
                className={cn(
                  "ml-1.5 size-1.5 rounded-full",
                  status.state === "starting" && "animate-pulse",
                )}
                style={{
                  background:
                    status.state === "running"
                      ? "var(--t-color-green9)"
                      : status.state === "failed"
                        ? "var(--t-color-red9)"
                        : "var(--t-color-gray8)",
                }}
              />
            }
          >
            <Input
              aria-label="Page"
              value={address}
              disabled={!url}
              onValueChange={(value) => setAddress(value)}
              className="font-mono"
            />
          </InputGroup>
        </form>
        <SegmentedControl<Device>
          aria-label="Width"
          size="sm"
          value={device}
          onValueChange={(value) => setDevice(value)}
          options={[
            {
              value: "desktop",
              startIcon: <IconDeviceDesktop size={14} />,
              "aria-label": "Desktop width",
            },
            {
              value: "tablet",
              startIcon: <IconDeviceTablet size={14} />,
              "aria-label": "Tablet width",
            },
            {
              value: "phone",
              startIcon: <IconDeviceMobile size={14} />,
              "aria-label": "Phone width",
            },
          ]}
        />
        <div className="mx-1 h-4 w-px bg-t-border" />
        <LightIconButton
          aria-label="Pick an element to change"
          aria-pressed={picking}
          tooltip="Pick an element to change"
          disabled={!url}
          onClick={togglePicking}
          className={cn(
            picking &&
              "!bg-[var(--t-accent-tertiary)] !text-[var(--t-color-blue11)]",
          )}
        >
          <IconClick size={16} />
        </LightIconButton>
        <LightIconButton
          aria-label="Open in a new tab"
          tooltip="Open in a new tab"
          disabled={!url}
          onClick={() => url && window.open(url + path, "_blank", "noopener")}
        >
          <IconExternalLink size={16} />
        </LightIconButton>
        <LightIconButton
          aria-label="Restart the dev server"
          tooltip="Restart the dev server"
          disabled={status.state === "starting" || !hasFiles}
          onClick={() => void start(true)}
        >
          <IconReload size={16} />
        </LightIconButton>
      </div>

      <div
        className={cn(
          "relative flex min-h-0 flex-1 justify-center overflow-auto",
          (width || !url) && "bg-t-secondary",
        )}
      >
        {url ? (
          <iframe
            key={`${url}:${reloads}`}
            ref={frame}
            title="Preview"
            src={url + path}
            className={cn(
              "h-full bg-white",
              width
                ? "my-4 rounded-lg border border-t-border shadow-[0_4px_16px_rgb(0_0_0/0.06)]"
                : "w-full",
            )}
            style={width ? { width, height: "calc(100% - 2rem)" } : undefined}
          />
        ) : status.state === "failed" ? (
          <EmptyState
            title="The preview did not start"
            action={
              <Button size="sm" variant="outline" onClick={() => void start()}>
                Try again
              </Button>
            }
          >
            <pre className="max-h-40 overflow-auto text-left font-mono text-[11px] whitespace-pre-wrap">
              {status.error}
            </pre>
          </EmptyState>
        ) : hasFiles ? (
          <div className="flex items-center">
            <Shimmer>Starting the preview…</Shimmer>
          </div>
        ) : (
          <EmptyState title="Your app shows here">
            It runs live as Richelieu builds it, and updates with each change.
          </EmptyState>
        )}

        {errors.length > 0 && (
          <div className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-md border border-t-border bg-t-primary p-2.5 pl-3 shadow-[0_0_4px_rgb(0_0_0/0.04),0_8px_24px_rgb(0_0_0/0.1)]">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-[var(--t-background-danger)] text-t-text-danger">
              <IconAlertTriangle size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-t-text">
                {errors.length === 1
                  ? "The app hit an error"
                  : `The app hit ${errors.length} errors`}
              </p>
              <p className="truncate font-mono text-[11px] text-t-text-tertiary">
                {errors.at(-1)!.message}
              </p>
            </div>
            <Button
              size="sm"
              variant="solid"
              color="accent"
              disabled={busy}
              onClick={() => {
                onFix(errors);
                setErrors([]);
              }}
            >
              Fix it
            </Button>
            <LightIconButton
              aria-label="Dismiss the errors"
              size="sm"
              onClick={() => setErrors([])}
            >
              <IconX size={14} />
            </LightIconButton>
          </div>
        )}
      </div>
    </div>
  );
}
