// The agent's browser, for the web app: start and close it, forget its sign-ins, and the live view, a WebSocket that
// streams the browser's screen and state and, once the user takes the controls, carries their mouse and keyboard.
// Only the project's owner reaches it; a browser WebSocket cannot send headers, so the access token rides in the URL.

import type { SQL } from "bun";
import type { BrowserSessions, LiveEvent } from "../browser/sessions.ts";
import { createUserAuth, handle, HttpError, type ApiRequest } from "./http.ts";

export type BrowserSocket = {
  kind: "browser";
  projectId: string;
  /** Whether the user holds the controls: input is ignored until they take them. */
  control: boolean;
  unsubscribe?: () => void;
};

type ClientMessage =
  | { type: "control"; on: boolean }
  | { type: "start" }
  | { type: "mouse"; action: "down" | "up" | "move"; x: number; y: number; button?: "left" | "right" | "middle"; clicks?: number }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; action: "down" | "up"; key: string }
  | { type: "text"; text: string }
  | { type: "navigate"; url: string }
  | { type: "back" | "forward" | "reload" | "done" }
  | { type: "tab"; index: number };

/** Frames beyond this much unsent data are dropped: the live view shows the latest, it does not queue. */
const MAX_BUFFERED = 1_500_000;

export function createBrowserApi({ sql, sessions }: { sql: SQL; sessions: BrowserSessions | undefined }) {
  const userOf = createUserAuth();

  async function ownedProject(request: Request, projectId: string) {
    const userId = await userOf(request);
    const [found] = await sql<{ id: string }[]>`
      SELECT id FROM public.projects WHERE id = ${projectId} AND user_id = ${userId}`;
    if (!found) throw new HttpError(404, "No such project");
    return found.id;
  }

  const need = () => {
    if (!sessions) throw new HttpError(503, "The browser needs Docker, which this server does not have");
    return sessions;
  };

  const routes = {
    "/api/projects/:id/browser": {
      POST: handle(async (request: ApiRequest) => {
        const id = await ownedProject(request, request.params.id!);
        await need().ensure(id);
        return { ok: true };
      }),
      DELETE: handle(async (request: ApiRequest) => {
        const id = await ownedProject(request, request.params.id!);
        await need().close(id);
        return { ok: true };
      }),
    },
    "/api/projects/:id/browser/profile": {
      DELETE: handle(async (request: ApiRequest) => {
        const id = await ownedProject(request, request.params.id!);
        await need().forget(id);
        return { ok: true };
      }),
    },
    "/api/projects/:id/browser/live": async (request: ApiRequest, server: Bun.Server<BrowserSocket>) => {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return new Response("Expected a WebSocket", { status: 426 });
      const token = new URL(request.url).searchParams.get("token") ?? "";
      let projectId: string;
      try {
        projectId = await ownedProject(
          new Request(request.url, { headers: { authorization: `Bearer ${token}` } }),
          request.params.id!,
        );
        need();
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        return new Response(error instanceof Error ? error.message : "Error", { status });
      }
      if (server.upgrade(request, { data: { kind: "browser", projectId, control: false } })) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    },
  };

  const websocket: Bun.WebSocketHandler<BrowserSocket> = {
    open(ws) {
      ws.data.unsubscribe = need().subscribe(ws.data.projectId, (event: LiveEvent) => {
        if (event.type === "frame" && ws.getBufferedAmount() > MAX_BUFFERED) return;
        ws.send(JSON.stringify(event));
      });
    },
    async message(ws, raw) {
      let message: ClientMessage;
      try {
        message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        return;
      }
      const browser = need();
      try {
        if (message.type === "control") ws.data.control = message.on === true;
        else if (message.type === "start") await browser.ensure(ws.data.projectId);
        else if (message.type === "done") await browser.input(ws.data.projectId, { type: "done" });
        else if (ws.data.control) await browser.input(ws.data.projectId, message);
      } catch (error) {
        ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
      }
    },
    close(ws) {
      ws.data.unsubscribe?.();
    },
  };

  return { routes, websocket };
}
