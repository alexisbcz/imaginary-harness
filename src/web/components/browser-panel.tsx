// The agent's browser, live: its screen streamed over a WebSocket, its address and tabs, what the agent is doing,
// and the controls. Watching is passive; "Take control" sends the user's mouse, wheel and keyboard to the browser,
// to sign in or get past a check the agent handed over (it asks with a banner, and "I'm done" hands back).

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "cn";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button } from "twenty-ui/primitives/input";
import { LightIconButton } from "twenty-ui/components/input";
import {
  IconArrowLeft,
  IconArrowRight,
  IconDotsVertical,
  IconHandStop,
  IconLock,
  IconRefresh,
  IconWorldWww,
} from "@tabler/icons-react";

import { IconTile } from "@/components/icon-tile";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

type LiveState = {
  running: boolean;
  url: string;
  title: string;
  tabs: { index: number; title: string; url: string; active: boolean }[];
  needsUser: string | null;
  busy: boolean;
};

type Connection = "connecting" | "open" | "closed" | "unavailable";

/** Keeps a WebSocket to the project's browser open, reconnecting with backoff. */
function useLiveBrowser(projectId: string, onFrame: (data: string, width: number, height: number) => void) {
  const [state, setState] = useState<LiveState | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const socket = useRef<WebSocket | null>(null);
  const frame = useRef(onFrame);
  frame.current = onFrame;

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let timer: Timer | undefined;
    const connect = async () => {
      const { data } = await createClient().auth.getSession();
      if (stopped) return;
      const origin = window.location.origin.replace(/^http/, "ws");
      const ws = new WebSocket(
        `${origin}/api/projects/${projectId}/browser/live?token=${encodeURIComponent(data.session?.access_token ?? "")}`,
      );
      socket.current = ws;
      setConnection("connecting");
      ws.onopen = () => {
        attempt = 0;
        setConnection("open");
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as
          | { type: "frame"; data: string; width: number; height: number }
          | { type: "state"; state: LiveState }
          | { type: "error"; message: string };
        if (message.type === "frame") frame.current(message.data, message.width, message.height);
        else if (message.type === "state") setState(message.state);
      };
      ws.onclose = (event) => {
        if (socket.current === ws) socket.current = null;
        if (stopped) return;
        // 503 at the upgrade: no Docker here. Anything else: try again, more slowly each time.
        if (event.code === 1006 && attempt > 2) setConnection("closed");
        attempt++;
        timer = setTimeout(() => void connect(), Math.min(10_000, 500 * 2 ** attempt));
      };
    };
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket.current?.close();
    };
  }, [projectId]);

  const send = useCallback((message: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);

  return { state, connection, send };
}

/** The key names Playwright expects for keys that type nothing. */
const SPECIAL_KEYS = new Set([
  "Enter", "Backspace", "Tab", "Escape", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "Shift", "Control", "Alt", "Meta", "CapsLock", "Insert",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
]);

export function BrowserPanel({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const { t } = useTranslation("builder");
  const image = useRef<HTMLImageElement>(null);
  const size = useRef({ width: 1280, height: 800 });
  const [hasFrame, setHasFrame] = useState(false);
  const [control, setControl] = useState(false);
  const [address, setAddress] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const lastMove = useRef(0);

  const onFrame = useCallback((data: string, width: number, height: number) => {
    size.current = { width, height };
    if (image.current) image.current.src = `data:image/jpeg;base64,${data}`;
    setHasFrame(true);
  }, []);
  const { state, connection, send } = useLiveBrowser(projectId, onFrame);
  const running = state?.running ?? false;

  useEffect(() => {
    if (!editingAddress) setAddress(state?.url && state.url !== "about:blank" ? state.url : "");
  }, [state?.url, editingAddress]);
  useEffect(() => {
    if (!running) {
      setHasFrame(false);
      setControl(false);
    } else setStarting(false);
  }, [running]);
  // The agent asks for help: offer the controls right away.
  useEffect(() => {
    send({ type: "control", on: control });
  }, [control, send, connection]);

  const point = (event: { clientX: number; clientY: number }) => {
    const rect = image.current!.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * size.current.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * size.current.height),
    };
  };
  const buttonOf = (button: number) => (button === 2 ? "right" : button === 1 ? "middle" : "left");

  const mouse = (action: "down" | "up" | "move") => (event: MouseEvent) => {
    if (!control) return;
    if (action === "move") {
      const now = performance.now();
      if (now - lastMove.current < 33) return;
      lastMove.current = now;
    }
    if (action === "down") (event.currentTarget as HTMLElement).focus();
    event.preventDefault();
    send({ type: "mouse", action, ...point(event), button: buttonOf(event.button), clicks: event.detail || 1 });
  };

  const wheel = (event: WheelEvent) => {
    if (!control) return;
    send({ type: "wheel", ...point(event), dx: event.deltaX, dy: event.deltaY });
  };

  const key = (action: "down" | "up") => (event: KeyboardEvent) => {
    if (!control) return;
    const combo = event.metaKey || event.ctrlKey || event.altKey;
    if (action === "down" && event.key.length === 1 && !combo) {
      event.preventDefault();
      send({ type: "text", text: event.key });
      return;
    }
    // Pasting goes through the paste event, with the text.
    if (combo && event.key.toLowerCase() === "v") return;
    if (event.key.length === 1 || SPECIAL_KEYS.has(event.key)) {
      event.preventDefault();
      send({ type: "key", action, key: event.key.length === 1 ? event.key.toLowerCase() : event.key });
    }
  };

  async function start() {
    setStarting(true);
    setNotice(null);
    try {
      await api(`/api/projects/${projectId}/browser`, { body: {} });
    } catch (error) {
      setStarting(false);
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  if (connection === "closed" && !state)
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-t-text-secondary">{t("browser.unavailable")}</div>
    );

  if (!running)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <IconTile size="lg" color="sky">
          <IconWorldWww />
        </IconTile>
        <div className="flex max-w-[420px] flex-col gap-1.5">
          <p className="text-[15px] font-semibold text-t-text">{t("browser.idleTitle")}</p>
          <p className="leading-[1.55] text-t-text-secondary">{t("browser.idleBody")}</p>
        </div>
        <Button size="sm" variant="solid" color="accent" loading={starting} disabled={connection !== "open"} onClick={() => void start()}>
          {starting ? t("browser.opening") : t("browser.open")}
        </Button>
        {connection === "connecting" && <span className="text-[12px] text-t-text-light">{t("browser.connecting")}</span>}
        {notice && <p className="text-t-text-danger">{notice}</p>}
      </div>
    );

  const tabs = state?.tabs ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-t-border-light px-2">
        <LightIconButton aria-label={t("browser.back")} tooltip={t("browser.back")} disabled={!control} onClick={() => send({ type: "back" })}>
          <IconArrowLeft size={16} />
        </LightIconButton>
        <LightIconButton aria-label={t("browser.forward")} tooltip={t("browser.forward")} disabled={!control} onClick={() => send({ type: "forward" })}>
          <IconArrowRight size={16} />
        </LightIconButton>
        <LightIconButton aria-label={t("browser.reload")} tooltip={t("browser.reload")} disabled={!control} onClick={() => send({ type: "reload" })}>
          <IconRefresh size={16} />
        </LightIconButton>
        <form
          className="mx-1 flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-t-secondary px-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!address.trim()) return;
            if (!control) setControl(true);
            send({ type: "control", on: true });
            send({ type: "navigate", url: address.trim() });
            setEditingAddress(false);
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          {address.startsWith("https://") && <IconLock size={12} className="shrink-0 text-t-text-tertiary" />}
          <input
            aria-label={t("browser.address")}
            value={address}
            placeholder={t("browser.addressPlaceholder")}
            onFocus={() => setEditingAddress(true)}
            onBlur={() => setEditingAddress(false)}
            onChange={(event) => setAddress(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-t-text outline-none placeholder:text-t-text-light"
          />
        </form>
        <span
          className={cn(
            "hidden shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium sm:flex",
            control
              ? "bg-[color-mix(in_oklab,var(--t-color-orange9)_16%,transparent)] text-[var(--t-color-orange11)]"
              : state?.busy
                ? "bg-[color-mix(in_oklab,var(--t-color-blue9)_14%,transparent)] text-[var(--t-color-blue11)]"
                : "text-t-text-tertiary",
          )}
        >
          <span className={cn("size-1.5 rounded-full", control ? "bg-[var(--t-color-orange9)]" : state?.busy ? "animate-pulse bg-[var(--t-color-blue9)]" : "bg-[var(--t-color-green9)]")} />
          {control ? t("browser.youHaveControl") : state?.busy ? t("browser.agentWorking") : t("browser.watching")}
        </span>
        <Button
          size="sm"
          variant={control ? "solid" : "outline"}
          color={control ? "accent" : undefined}
          startIcon={<IconHandStop size={14} />}
          onClick={() => setControl((on) => !on)}
        >
          {control ? t("browser.giveBack") : t("browser.takeControl")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<LightIconButton aria-label={t("browser.menu")}><IconDotsVertical size={16} /></LightIconButton>} />
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onClick={() => void api(`/api/projects/${projectId}/browser`, { method: "DELETE" })}>
              {t("browser.close")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void api(`/api/projects/${projectId}/browser/profile`, { method: "DELETE" }).then(() => setNotice(t("browser.forgotten")))
              }
            >
              {t("browser.forget")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {tabs.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-t-border-light px-2 py-1" role="tablist" aria-label={t("browser.tabs")}>
          {tabs.map((tab) => (
            <button
              key={tab.index}
              type="button"
              role="tab"
              aria-selected={tab.active}
              disabled={!control}
              onClick={() => send({ type: "tab", index: tab.index })}
              className={cn(
                "max-w-[220px] shrink-0 truncate rounded-md px-2.5 py-1 text-[12px]",
                tab.active ? "bg-t-hover font-medium text-t-text" : "text-t-text-secondary hover:bg-t-hover",
              )}
            >
              {tab.title || t("browser.untitledTab")}
            </button>
          ))}
        </div>
      )}

      {state?.needsUser && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-t-border-light bg-[color-mix(in_oklab,var(--t-color-orange9)_10%,var(--t-background-primary))] px-4 py-2.5">
          <IconHandStop size={18} className="shrink-0 text-[var(--t-color-orange10)]" />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold text-[var(--t-color-orange11)]">{t("browser.needsYou")}</div>
            <div className="text-t-text">{state.needsUser}</div>
          </div>
          {!control && (
            <Button size="sm" variant="outline" onClick={() => setControl(true)}>
              {t("browser.takeControl")}
            </Button>
          )}
          <Button
            size="sm"
            variant="solid"
            color="accent"
            onClick={() => {
              send({ type: "done" });
              setControl(false);
              onDone();
            }}
          >
            {t("browser.done")}
          </Button>
        </div>
      )}
      {notice && (
        <button type="button" onClick={() => setNotice(null)} className="shrink-0 border-b border-t-border-light px-4 py-1.5 text-left text-[12px] text-t-text-secondary">
          {notice}
        </button>
      )}

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#0b0b0c] p-2">
        {!hasFrame && <Loader />}
        <img
          ref={image}
          alt={state?.title || t("browser.title")}
          draggable={false}
          tabIndex={0}
          onMouseDown={mouse("down")}
          onMouseUp={mouse("up")}
          onMouseMove={mouse("move")}
          onWheel={wheel}
          onKeyDown={key("down")}
          onKeyUp={key("up")}
          onPaste={(event) => {
            if (!control) return;
            event.preventDefault();
            send({ type: "text", text: event.clipboardData.getData("text") });
          }}
          onContextMenu={(event) => control && event.preventDefault()}
          className={cn(
            "max-h-full max-w-full rounded-sm shadow-2xl outline-none select-none",
            !hasFrame && "hidden",
            control ? "cursor-default ring-2 ring-[var(--t-color-orange9)]" : "cursor-not-allowed",
          )}
        />
        {hasFrame && !control && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 text-[12px] text-white/90 backdrop-blur">
            {t("browser.takeControlHint")}
          </div>
        )}
      </div>
    </div>
  );
}
