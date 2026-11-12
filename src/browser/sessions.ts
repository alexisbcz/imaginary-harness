// A real browser for each project: Chromium in a Docker container of its own (Playwright's image, serving Playwright's
// protocol: `playwright run-server`), driven from here with playwright-core.
// The agent reads pages as accessibility snapshots with element refs (Playwright's `ariaSnapshot({ mode: "ai" })`,
// the model Playwright MCP gives coding agents) and acts on those refs; the user watches it live in the project's
// Browser tab (Playwright's screencast) and can take the controls, to sign in or get past a check only a person should.
//
// Sign-ins survive: a session's cookies and storage are kept, sealed, per project, and come back the next time.
// The browser reaches the public web and the project's own preview, never this machine's other services or the
// private network.

import type { SQL } from "bun";
import { chromium, type Browser, type BrowserContext, type Dialog, type Page } from "playwright-core";
import { open, seal } from "../newsletter/secrets.ts";

/** Built from docker/browser/Dockerfile: Playwright 1.65's image, matching playwright-core. */
export const BROWSER_IMAGE = "richelieu-browser:1.65.0";
const ROOT = new URL("../../", import.meta.url).pathname;
const PREFIX = "richelieu-browser-";
const IDLE_MS = 15 * 60_000;
const READY_TIMEOUT_MS = 30_000;
export const VIEWPORT = { width: 1280, height: 800 };
const MAX_LOG = 300;

export type ConsoleEntry = { type: string; text: string; url: string; at: number };
export type NetworkEntry = { method: string; url: string; status: number | null; type: string; failure?: string; at: number };

export type LiveEvent =
  | { type: "frame"; data: string; width: number; height: number }
  | { type: "state"; state: LiveState };

export type LiveState = {
  running: boolean;
  url: string;
  title: string;
  tabs: { index: number; title: string; url: string; active: boolean }[];
  /** Why the agent handed the browser to the user, until the user says it is done. */
  needsUser: string | null;
  /** The agent is acting right now. */
  busy: boolean;
};

type Session = {
  projectId: string;
  name: string;
  browser: Browser;
  context: BrowserContext;
  pages: Page[];
  active: Page;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  /** Read marks for the console and network logs, so tools report what is new. */
  seen: { console: number; network: number };
  dialog: Dialog | null;
  /** Hosts beyond the public web the browser may reach: the project's preview. */
  allowed: Set<string>;
  lastUsed: number;
  needsUser: string | null;
  busy: number;
  screencast: Page | null;
};

async function run(argv: string[], timeoutMs = 60_000) {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearTimeout(timer));
  return { stdout, stderr, exitCode };
}

/** Whether an address is this machine, the private network, or a cloud metadata service. */
export function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) ||
    host === "::1" ||
    host === "::" ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host) ||
    /^::ffff:(127|10|192\.168|169\.254)\./.test(host)
  );
}

/**
 * Opens a URL, once more when a late navigation interrupted it: after a blocked or failed address, Chromium loads
 * its error page a moment later, which cuts off the next navigation.
 */
export async function goto(page: Page, url: string, timeout = 45_000) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    } catch (error) {
      if (!/interrupted by another navigation/i.test(String(error)) || attempt >= 2) throw error;
      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
      await Bun.sleep(300);
      // The navigation that interrupted ours may have been ours, finishing: then we are there.
      if (page.url() === new URL(url).toString()) return null;
    }
  }
}

export class BrowserSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<string, Promise<Session>>();
  private readonly listeners = new Map<string, Set<(event: LiveEvent) => void>>();
  private reaper: Timer | undefined;

  constructor(private readonly sql: SQL) {}

  /** Removes browsers a previous process left, and starts closing idle ones. */
  async start() {
    const { stdout } = await run(["docker", "ps", "-aq", "--filter", "label=richelieu.browser=1"]);
    const ids = stdout.split("\n").filter(Boolean);
    if (ids.length) await run(["docker", "rm", "-f", ...ids]);
    this.reaper = setInterval(() => void this.reap(), 60_000);
    // Build the image now, so the first browser does not wait for it.
    void this.ensureImage().catch((error) => console.error("[browser] image:", error));
  }

  async stop() {
    clearInterval(this.reaper);
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  private image: Promise<void> | undefined;

  /** Builds the browser image unless it exists: a few minutes the first time (Playwright's image is about 2 GB). */
  ensureImage() {
    this.image ??= (async () => {
      if ((await run(["docker", "image", "inspect", BROWSER_IMAGE])).exitCode === 0) return;
      console.log(`[browser] building ${BROWSER_IMAGE}, a few minutes the first time`);
      const build = await run(
        ["docker", "build", "-f", "docker/browser/Dockerfile", "-t", BROWSER_IMAGE, `${ROOT}docker/browser`],
        20 * 60_000,
      );
      if (build.exitCode !== 0) {
        this.image = undefined;
        throw new Error(`Could not build the browser image: ${build.stderr.slice(-1500)}`);
      }
    })();
    return this.image;
  }

  get(projectId: string) {
    return this.sessions.get(projectId);
  }

  /** The project's browser, started when it has none. */
  ensure(projectId: string): Promise<Session> {
    const existing = this.sessions.get(projectId);
    if (existing && existing.browser.isConnected()) {
      existing.lastUsed = Date.now();
      return Promise.resolve(existing);
    }
    let starting = this.starting.get(projectId);
    if (!starting) {
      starting = this.boot(projectId).finally(() => this.starting.delete(projectId));
      this.starting.set(projectId, starting);
    }
    return starting;
  }

  private async boot(projectId: string): Promise<Session> {
    const name = PREFIX + projectId;
    await run(["docker", "rm", "-f", name]);
    await this.ensureImage();
    const created = await run([
      "docker", "run", "-d",
      "--name", name,
      "--label", "richelieu.browser=1",
      "--init",
      "--publish", "127.0.0.1::3000",
      "--memory", "1536m",
      "--cpus", "1.5",
      "--pids-limit", "1024",
      "--shm-size", "512m",
      "--security-opt", "no-new-privileges",
      // The project's preview runs on this machine: the browser reaches it, and only it, through this name.
      "--add-host", "host.docker.internal:host-gateway",
      BROWSER_IMAGE,
    ]);
    if (created.exitCode !== 0) throw new Error(`Could not start the browser: ${created.stderr.trim()}`);
    const browser = await this.connect(name);
    const version = browser.version().split(".")[0] ?? "158";
    const storageState = await this.loadProfile(projectId);
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      // A browser's ordinary identity, not "HeadlessChrome", which many sites turn away.
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`,
      locale: "en-US",
      acceptDownloads: false,
      ...(storageState ? { storageState } : {}),
    });
    const session: Session = {
      projectId,
      name,
      browser,
      context,
      pages: [],
      active: undefined as unknown as Page,
      console: [],
      network: [],
      seen: { console: 0, network: 0 },
      dialog: null,
      allowed: new Set(),
      lastUsed: Date.now(),
      needsUser: null,
      busy: 0,
      screencast: null,
    };
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (!/^(https?|data|blob|about):$/.test(url.protocol)) return route.abort("blockedbyclient");
      if (/^https?:$/.test(url.protocol) && isPrivateHost(url.hostname) && !session.allowed.has(url.host))
        return route.abort("blockedbyclient");
      return route.continue();
    });
    context.on("page", (page) => this.track(session, page));
    browser.on("disconnected", () => {
      if (this.sessions.get(projectId) === session) {
        this.sessions.delete(projectId);
        this.emit(projectId, { type: "state", state: this.stateOf(undefined) });
      }
    });
    const first = await context.newPage();
    this.track(session, first);
    this.sessions.set(projectId, session);
    this.emitState(session);
    return session;
  }

  /** Connects to the container's Playwright server once it listens. */
  private async connect(name: string): Promise<Browser> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const port = (await run(["docker", "port", name, "3000/tcp"])).stdout.split("\n")[0]?.split(":").pop()?.trim();
      if (port) {
        const browser = await chromium.connect(`ws://127.0.0.1:${port}/`, { timeout: 3_000 }).catch(() => null);
        if (browser) return browser;
      }
      await Bun.sleep(400);
    }
    const logs = await run(["docker", "logs", "--tail", "30", name]);
    throw new Error(`The browser did not start: ${(logs.stdout + logs.stderr).trim().slice(-800)}`);
  }

  private track(session: Session, page: Page) {
    if (session.pages.includes(page)) return;
    session.pages.push(page);
    session.active = page;
    const log = <T>(list: T[], entry: T) => {
      list.push(entry);
      if (list.length > MAX_LOG) {
        const cut = list.length - MAX_LOG;
        list.splice(0, cut);
        if (list === (session.console as unknown)) session.seen.console = Math.max(0, session.seen.console - cut);
        else session.seen.network = Math.max(0, session.seen.network - cut);
      }
    };
    page.on("console", (message) =>
      log(session.console, { type: message.type(), text: message.text().slice(0, 2000), url: page.url(), at: Date.now() }),
    );
    page.on("pageerror", (error) =>
      log(session.console, { type: "error", text: `Uncaught: ${error.message}`.slice(0, 2000), url: page.url(), at: Date.now() }),
    );
    page.on("requestfinished", async (request) => {
      const response = await request.response().catch(() => null);
      log(session.network, { method: request.method(), url: request.url(), status: response?.status() ?? null, type: request.resourceType(), at: Date.now() });
    });
    page.on("requestfailed", (request) =>
      log(session.network, { method: request.method(), url: request.url(), status: null, type: request.resourceType(), failure: request.failure()?.errorText, at: Date.now() }),
    );
    page.on("dialog", (dialog) => {
      // An alert or a page asking to stay only needs acknowledging; a confirm or a prompt waits for the agent.
      if (dialog.type() === "alert" || dialog.type() === "beforeunload") {
        log(session.console, { type: "dialog", text: `${dialog.type()}: ${dialog.message()}`, url: page.url(), at: Date.now() });
        void dialog.accept().catch(() => undefined);
      } else session.dialog = dialog;
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.emitState(session);
    });
    page.on("load", () => this.emitState(session));
    page.on("close", () => {
      session.pages = session.pages.filter((p) => p !== page);
      if (session.active === page && session.pages.length) void this.activate(session, session.pages.at(-1)!);
      this.emitState(session);
    });
    void this.restartScreencast(session);
  }

  /** Makes a tab the one the agent acts on and the user watches. */
  async activate(session: Session, page: Page) {
    session.active = page;
    await page.bringToFront().catch(() => undefined);
    await this.restartScreencast(session);
    this.emitState(session);
  }

  /** Lets the browser reach the project's preview, on this machine. */
  allow(session: Session, host: string) {
    session.allowed.add(host);
  }

  /** Marks the agent at work, for the live view; returns the function that ends it. */
  working(session: Session) {
    session.busy++;
    session.lastUsed = Date.now();
    this.emitState(session);
    return () => {
      session.busy = Math.max(0, session.busy - 1);
      this.emitState(session);
    };
  }

  setNeedsUser(session: Session, reason: string | null) {
    session.needsUser = reason;
    this.emitState(session);
  }

  newConsole(session: Session) {
    const fresh = session.console.slice(session.seen.console);
    session.seen.console = session.console.length;
    return fresh;
  }

  newNetwork(session: Session) {
    const fresh = session.network.slice(session.seen.network);
    session.seen.network = session.network.length;
    return fresh;
  }

  /** Closes the project's browser, keeping its sign-ins unless asked not to. */
  async close(projectId: string, options: { keepProfile?: boolean } = {}) {
    const session = this.sessions.get(projectId);
    this.sessions.delete(projectId);
    if (session) {
      if (options.keepProfile !== false) await this.saveProfile(session).catch((e) => console.warn("[browser] profile:", e));
      await session.browser.close().catch(() => undefined);
      await run(["docker", "rm", "-f", session.name]);
    }
    this.emit(projectId, { type: "state", state: this.stateOf(undefined) });
  }

  /** Forgets the project's sign-ins and cookies. */
  async forget(projectId: string) {
    const session = this.sessions.get(projectId);
    if (session) await session.context.clearCookies().catch(() => undefined);
    await this.sql`DELETE FROM public.browser_profiles WHERE project_id = ${projectId}`;
  }

  private async saveProfile(session: Session) {
    const state = await session.context.storageState();
    if (!state.cookies.length && !state.origins.length) return;
    const sealed = await seal(JSON.stringify(state));
    await this.sql`
      INSERT INTO public.browser_profiles (project_id, state_sealed) VALUES (${session.projectId}, ${sealed})
      ON CONFLICT (project_id) DO UPDATE SET state_sealed = EXCLUDED.state_sealed, updated_at = now()`;
  }

  private async loadProfile(projectId: string) {
    const [row] = await this.sql<{ state_sealed: string }[]>`
      SELECT state_sealed FROM public.browser_profiles WHERE project_id = ${projectId}`;
    if (!row) return undefined;
    try {
      return JSON.parse(await open(row.state_sealed));
    } catch {
      return undefined;
    }
  }

  private async reap() {
    for (const [projectId, session] of this.sessions)
      if (!session.busy && !this.listeners.get(projectId)?.size && Date.now() - session.lastUsed > IDLE_MS)
        await this.close(projectId);
  }

  // Live view ------------------------------------------------------------------------------------------------

  stateOf(session: Session | undefined): LiveState {
    if (!session) return { running: false, url: "", title: "", tabs: [], needsUser: null, busy: false };
    return {
      running: true,
      url: session.active?.url() ?? "",
      title: "",
      tabs: session.pages.map((page, index) => ({ index, title: "", url: page.url(), active: page === session.active })),
      needsUser: session.needsUser,
      busy: session.busy > 0,
    };
  }

  private emitState(session: Session) {
    const state = this.stateOf(session);
    // Titles need a round trip: send the state at once, then with titles.
    this.emit(session.projectId, { type: "state", state });
    void Promise.all(session.pages.map((page) => page.title().catch(() => ""))).then((titles) => {
      const withTitles = {
        ...state,
        title: titles[session.pages.indexOf(session.active)] ?? "",
        tabs: state.tabs.map((tab, i) => ({ ...tab, title: titles[i] ?? "" })),
      };
      this.emit(session.projectId, { type: "state", state: withTitles });
    });
  }

  private emit(projectId: string, event: LiveEvent) {
    for (const listener of this.listeners.get(projectId) ?? []) listener(event);
  }

  /** Follows a project's browser: its screen and its state. Returns the function that stops following. */
  subscribe(projectId: string, listener: (event: LiveEvent) => void) {
    let set = this.listeners.get(projectId);
    if (!set) this.listeners.set(projectId, (set = new Set()));
    set.add(listener);
    const session = this.sessions.get(projectId);
    listener({ type: "state", state: this.stateOf(session) });
    if (session) {
      this.emitState(session);
      void this.restartScreencast(session);
    }
    return () => {
      set.delete(listener);
      const current = this.sessions.get(projectId);
      if (current && !set.size) void this.stopScreencast(current);
    };
  }

  private async stopScreencast(session: Session) {
    const page = session.screencast;
    session.screencast = null;
    if (page && !page.isClosed()) await page.screencast.stop().catch(() => undefined);
  }

  private async restartScreencast(session: Session) {
    if (!this.listeners.get(session.projectId)?.size) return;
    if (session.screencast === session.active) return;
    await this.stopScreencast(session);
    const page = session.active;
    if (!page || page.isClosed()) return;
    session.screencast = page;
    try {
      await page.screencast.start({
        size: VIEWPORT,
        quality: 70,
        fps: 15,
        onFrame: ({ data, viewportWidth, viewportHeight }) => {
          if (session.screencast !== page) return;
          this.emit(session.projectId, {
            type: "frame",
            data: Buffer.from(data).toString("base64"),
            width: viewportWidth,
            height: viewportHeight,
          });
        },
      });
    } catch {
      if (session.screencast === page) session.screencast = null;
    }
  }

  // The user's hands, from the live view -------------------------------------------------------------------

  async input(
    projectId: string,
    event:
      | { type: "mouse"; action: "down" | "up" | "move"; x: number; y: number; button?: "left" | "right" | "middle"; clicks?: number }
      | { type: "wheel"; x: number; y: number; dx: number; dy: number }
      | { type: "key"; action: "down" | "up"; key: string }
      | { type: "text"; text: string }
      | { type: "navigate"; url: string }
      | { type: "back" | "forward" | "reload" }
      | { type: "tab"; index: number }
      | { type: "done" },
  ) {
    const session = this.sessions.get(projectId);
    if (!session) return;
    session.lastUsed = Date.now();
    const page = session.active;
    switch (event.type) {
      case "mouse": {
        await page.mouse.move(event.x, event.y);
        if (event.action === "down") await page.mouse.down({ button: event.button ?? "left", clickCount: event.clicks ?? 1 });
        if (event.action === "up") await page.mouse.up({ button: event.button ?? "left", clickCount: event.clicks ?? 1 });
        break;
      }
      case "wheel":
        await page.mouse.move(event.x, event.y);
        await page.mouse.wheel(event.dx, event.dy);
        break;
      case "key":
        if (event.action === "down") await page.keyboard.down(event.key);
        else await page.keyboard.up(event.key);
        break;
      case "text":
        await page.keyboard.insertText(event.text.slice(0, 5000));
        break;
      case "navigate": {
        const url = /^https?:\/\//i.test(event.url) ? event.url : `https://${event.url}`;
        await goto(page, url, 30_000).catch(() => undefined);
        break;
      }
      case "back":
        await page.goBack({ timeout: 15_000 }).catch(() => undefined);
        break;
      case "forward":
        await page.goForward({ timeout: 15_000 }).catch(() => undefined);
        break;
      case "reload":
        await page.reload({ timeout: 30_000 }).catch(() => undefined);
        break;
      case "tab": {
        const target = session.pages[event.index];
        if (target) await this.activate(session, target);
        break;
      }
      case "done":
        this.setNeedsUser(session, null);
        break;
    }
  }
}

export type { Session as BrowserSession };
