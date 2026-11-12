// The optional substack-mcp server (github.com/marcomoauro/substack-mcp): with SUBSTACK_MCP=true, a newsletter's
// copilot also reaches its tools (the reader feed, subscriber lists and exports, sixteen analytics reports, tags,
// comments). It speaks MCP over stdio; this is a minimal client for it: initialize, tools/list, tools/call.
//
// Each newsletter gets a process of its own, started on first use with that newsletter's credentials in its
// environment, and stopped after 10 idle minutes. The tools that publish, delete or post in the user's name are
// not offered: those stay with Richelieu's own tools, which ask the user first.

export const MCP_ENABLED = Bun.env.SUBSTACK_MCP === "true" || Boolean(Bun.env.SUBSTACK_MCP_COMMAND);
/** A pinned version: the server holds the user's Substack session. */
const COMMAND = (Bun.env.SUBSTACK_MCP_COMMAND ?? "npx -y substack-mcp@1.3.2").split(/\s+/).filter(Boolean);
const IDLE_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 120_000;

/** Tools the copilot never calls through the MCP: they publish, delete or speak for the user. */
export const BLOCKED_TOOLS = new Set(["publish_draft", "delete_draft", "comment_on_post", "restack_item"]);

export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
export type McpCredentials = { publicationUrl: string; token: string; userId: number };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: Timer };

class McpProcess {
  private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly pending = new Map<number, Pending>();
  private next = 1;
  private buffer = "";
  private stderr = "";
  readonly ready: Promise<void>;
  private idle: Timer | undefined;
  closed = false;

  constructor(credentials: McpCredentials, private readonly onExit: () => void) {
    this.process = Bun.spawn(COMMAND, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: Bun.env.PATH ?? "",
        HOME: Bun.env.HOME ?? "",
        SUBSTACK_PUBLICATION_URL: credentials.publicationUrl,
        SUBSTACK_SESSION_TOKEN: credentials.token,
        SUBSTACK_USER_ID: String(credentials.userId),
        SUBSTACK_MCP_LOG_LEVEL: "warn",
      },
    });
    void this.read();
    void this.readErrors();
    void this.process.exited.then(() => this.close(new Error(`substack-mcp exited${this.stderr ? `: ${this.stderr.slice(-400)}` : ""}`)));
    this.ready = this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "richelieu", version: "1.0.0" },
    }).then(() => this.notify("notifications/initialized"));
    this.touch();
  }

  private async read() {
    const decoder = new TextDecoder();
    for await (const chunk of this.process.stdout) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === undefined || message.method) continue;
        const waiting = this.pending.get(message.id);
        if (!waiting) continue;
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(message.error.message ?? "MCP error"));
        else waiting.resolve(message.result);
      }
    }
  }

  private async readErrors() {
    const decoder = new TextDecoder();
    for await (const chunk of this.process.stderr) this.stderr = (this.stderr + decoder.decode(chunk)).slice(-4000);
  }

  private write(message: Record<string, unknown>) {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    void this.process.stdin.flush();
  }

  private notify(method: string, params?: unknown) {
    this.write({ method, ...(params ? { params } : {}) });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("substack-mcp is not running"));
    this.touch();
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`substack-mcp did not answer ${method} in time`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ id, method, ...(params ? { params } : {}) });
    });
  }

  private touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(new Error("idle")), IDLE_MS);
  }

  close(reason: Error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(reason);
    }
    this.pending.clear();
    try {
      this.process.kill();
    } catch {}
    this.onExit();
  }
}

/** One substack-mcp process per newsletter, keyed by its credentials so a new cookie starts a new one. */
export class SubstackMcp {
  private readonly processes = new Map<string, { key: string; process: McpProcess }>();
  private tools: McpTool[] | undefined;

  get enabled() {
    return MCP_ENABLED;
  }

  private async processFor(newsletterId: string, credentials: McpCredentials) {
    if (!MCP_ENABLED) throw new Error("The Substack MCP is off: set SUBSTACK_MCP=true on the server");
    const key = `${credentials.publicationUrl}:${credentials.userId}:${Bun.hash(credentials.token)}`;
    const existing = this.processes.get(newsletterId);
    if (existing && existing.key === key && !existing.process.closed) return existing.process;
    existing?.process.close(new Error("replaced"));
    const process = new McpProcess(credentials, () => {
      if (this.processes.get(newsletterId)?.process === process) this.processes.delete(newsletterId);
    });
    this.processes.set(newsletterId, { key, process });
    await process.ready;
    return process;
  }

  /** The server's tools but the blocked ones. They are the same for every newsletter, so listed once. */
  async list(newsletterId: string, credentials: McpCredentials): Promise<McpTool[]> {
    if (!this.tools) {
      const process = await this.processFor(newsletterId, credentials);
      const result = await process.request<{ tools?: McpTool[] }>("tools/list", {});
      this.tools = (result.tools ?? []).filter((tool) => !BLOCKED_TOOLS.has(tool.name));
    }
    return this.tools;
  }

  async call(newsletterId: string, credentials: McpCredentials, name: string, args: Record<string, unknown>) {
    if (BLOCKED_TOOLS.has(name))
      throw new Error(`${name} is not available through the MCP: use Richelieu's own tools, which ask the user first`);
    const process = await this.processFor(newsletterId, credentials);
    const result = await process.request<{ content?: { type: string; text?: string }[]; isError?: boolean }>(
      "tools/call",
      { name, arguments: args },
    );
    const text = (result.content ?? [])
      .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
      .join("\n");
    return { text, isError: result.isError === true };
  }

  close() {
    for (const { process } of this.processes.values()) process.close(new Error("closing"));
    this.processes.clear();
  }
}
