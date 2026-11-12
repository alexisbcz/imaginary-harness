// Live previews: one Docker container per project, running the app's dev server with the template's packages baked
// into the image. A project's files are copied in when its preview starts and every commit after that is copied in
// as it lands, so the dev server hot-reloads. Previews stop after a while without use.

import { createHash } from "node:crypto";
import { tar } from "./tar.ts";
import type { FileChanges } from "../agent/workspace.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const PREFIX = "richelieu-preview-";
const READY_TIMEOUT_MS = 180_000;
const IDLE_MS = 30 * 60_000;
const MAX_ERRORS = 20;

export type PreviewState =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "running"; url: string }
  | { state: "failed"; error: string };

export type PreviewError = { message: string; stack?: string; at: string };

type Preview = {
  name: string;
  status: PreviewState;
  starting?: Promise<string>;
  lastUsed: number;
  errors: PreviewError[];
  /** Changes committed while the preview was starting: its files were read before them, so they land after. */
  pending?: FileChanges;
};

async function run(
  argv: string[],
  options: { stdin?: Uint8Array | string; timeoutMs?: number } = {},
) {
  const child = Bun.spawn(argv, {
    stdin:
      options.stdin === undefined
        ? "ignore"
        : new Blob([options.stdin as BlobPart]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs)
    : undefined;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearTimeout(timer));
  return { stdout, stderr, exitCode, timedOut };
}

/** Whether this machine can run previews: Docker answers. */
export async function dockerAvailable() {
  if (!Bun.which("docker")) return false;
  return (
    (
      await run(["docker", "info", "--format", "{{.ServerVersion}}"], {
        timeoutMs: 10_000,
      })
    ).exitCode === 0
  );
}

/** The preview image's tag: a hash of what goes into it, so a changed template or runtime builds a new one. */
async function imageTag() {
  const hash = createHash("sha256");
  for (const file of [
    "docker/app/Dockerfile",
    "templates/app/package.json",
    ...[...new Bun.Glob("docker/app/richelieu/*").scanSync(ROOT)].sort(),
  ]) {
    hash.update(file);
    hash.update(await Bun.file(ROOT + file).text());
  }
  return `richelieu-app:${hash.digest("hex").slice(0, 12)}`;
}

export class Previews {
  private readonly previews = new Map<string, Preview>();
  private image: Promise<string> | undefined;
  private reaper: Timer | undefined;

  constructor(
    /** Every file of a project's head. */
    private readonly files: (
      projectId: string,
    ) => Promise<Record<string, string>>,
  ) {}

  /** Removes previews a previous process left, and starts stopping idle ones. */
  async start() {
    const { stdout } = await run([
      "docker",
      "ps",
      "-aq",
      "--filter",
      `name=${PREFIX}`,
    ]);
    const ids = stdout.split("\n").filter(Boolean);
    if (ids.length) await run(["docker", "rm", "-f", ...ids]);
    this.reaper = setInterval(() => void this.reap(), 60_000);
    // Build the image now, so the first preview does not wait for it.
    void this.ensureImage().catch((error) =>
      console.error("[preview] image:", error),
    );
  }

  async stop() {
    clearInterval(this.reaper);
    await Promise.all([...this.previews.keys()].map((id) => this.remove(id)));
  }

  /** Builds the preview image unless it exists; the first build installs the template's packages. */
  ensureImage() {
    this.image ??= (async () => {
      const tag = await imageTag();
      if ((await run(["docker", "image", "inspect", tag])).exitCode === 0)
        return tag;
      console.log(`[preview] building ${tag}, a few minutes the first time`);
      const build = await run(
        ["docker", "build", "-f", "docker/app/Dockerfile", "-t", tag, ROOT],
        {
          timeoutMs: 15 * 60_000,
        },
      );
      if (build.exitCode !== 0) {
        this.image = undefined;
        throw new Error(
          `Could not build the preview image: ${build.stderr.slice(-2000)}`,
        );
      }
      return tag;
    })();
    return this.image;
  }

  private entry(projectId: string) {
    let preview = this.previews.get(projectId);
    if (!preview) {
      preview = {
        name: PREFIX + projectId,
        status: { state: "stopped" },
        lastUsed: Date.now(),
        errors: [],
      };
      this.previews.set(projectId, preview);
    }
    return preview;
  }

  /** The preview's state, after checking its container still runs: Docker or a person may have removed it. */
  async status(projectId: string): Promise<PreviewState> {
    const preview = this.previews.get(projectId);
    if (!preview) return { state: "stopped" };
    if (preview.status.state === "running" && !(await this.alive(preview)))
      preview.status = { state: "stopped" };
    return preview.status;
  }

  private async alive(preview: Preview) {
    const state = await run([
      "docker",
      "inspect",
      "-f",
      "{{.State.Running}}",
      preview.name,
    ]);
    return state.stdout.trim() === "true";
  }

  /** Starts the project's preview unless it runs, and resolves with its URL once the dev server answers. */
  ensure(projectId: string): Promise<string> {
    const preview = this.entry(projectId);
    preview.lastUsed = Date.now();
    preview.starting ??= (async () => {
      if (preview.status.state === "running" && (await this.alive(preview)))
        return preview.status.url;
      return this.boot(projectId, preview);
    })().finally(() => {
      preview.starting = undefined;
    });
    return preview.starting;
  }

  private async boot(projectId: string, preview: Preview) {
    preview.status = { state: "starting" };
    try {
      const image = await this.ensureImage();
      await run(["docker", "rm", "-f", preview.name]);
      const create = await run([
        "docker",
        "create",
        "--name",
        preview.name,
        "--label",
        "richelieu.preview=1",
        "--publish",
        "127.0.0.1::5173",
        "--memory",
        "1g",
        "--cpus",
        "1",
        "--pids-limit",
        "512",
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        image,
      ]);
      if (create.exitCode !== 0) throw new Error(create.stderr.trim());
      await this.copyIn(preview.name, await this.files(projectId));
      const started = await run(["docker", "start", preview.name]);
      if (started.exitCode !== 0) throw new Error(started.stderr.trim());
      const url = await this.waitReady(preview.name);
      preview.status = { state: "running", url };
      await this.flushPending(projectId, preview);
      return url;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      preview.status = { state: "failed", error: message };
      throw new Error(message);
    }
  }

  private async waitReady(name: string) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let url: string | undefined;
    while (Date.now() < deadline) {
      const state = await run([
        "docker",
        "inspect",
        "-f",
        "{{.State.Running}}",
        name,
      ]);
      if (state.stdout.trim() !== "true") {
        const logs = await run(["docker", "logs", "--tail", "40", name]);
        throw new Error(
          `The dev server stopped:\n${(logs.stdout + logs.stderr).trim()}`,
        );
      }
      if (!url) {
        const port = (await run(["docker", "port", name, "5173/tcp"])).stdout
          .split("\n")[0]
          ?.split(":")
          .pop();
        if (port) url = `http://localhost:${port}`;
      }
      if (url) {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(2000),
        }).catch(() => undefined);
        if (response?.ok) return url;
      }
      await Bun.sleep(500);
    }
    throw new Error("The dev server did not start in time");
  }

  private async copyIn(name: string, files: Record<string, string>) {
    if (Object.keys(files).length === 0) return;
    const copy = await run(["docker", "cp", "-", `${name}:/app`], {
      stdin: tar(files),
    });
    if (copy.exitCode !== 0)
      throw new Error(`Could not copy the files in: ${copy.stderr.trim()}`);
  }

  private async flushPending(projectId: string, preview: Preview) {
    const pending = preview.pending;
    preview.pending = undefined;
    if (pending) await this.apply(projectId, pending);
  }

  /** Applies committed changes to a running preview; a changed package.json reinstalls and restarts it. */
  async apply(projectId: string, changes: FileChanges) {
    const preview = this.previews.get(projectId);
    if (!preview) return;
    if (preview.status.state === "starting") {
      preview.pending = { ...preview.pending, ...changes };
      return;
    }
    if (preview.status.state !== "running") return;
    if (!(await this.alive(preview))) {
      // Gone: the next `ensure` starts a fresh one from the committed files, these changes included.
      preview.status = { state: "stopped" };
      return;
    }
    const written = Object.fromEntries(
      Object.entries(changes).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    );
    const deleted = Object.keys(changes).filter(
      (path) => changes[path] === null,
    );
    await this.copyIn(preview.name, written);
    if (deleted.length)
      await run([
        "docker",
        "exec",
        "-u",
        "root",
        preview.name,
        "rm",
        "-f",
        "--",
        ...deleted.map((p) => `/app/${p}`),
      ]);
    if ("package.json" in changes) await this.restart(projectId);
  }

  /** Restarts the dev server, which installs packages first when package.json changed. */
  async restart(projectId: string) {
    const preview = this.previews.get(projectId);
    if (!preview || preview.status.state !== "running")
      return this.ensure(projectId);
    preview.status = { state: "starting" };
    preview.starting = (async () => {
      await run(["docker", "restart", "-t", "2", preview.name]);
      const url = await this.waitReady(preview.name);
      preview.status = { state: "running", url };
      await this.flushPending(projectId, preview);
      return url;
    })()
      .catch((error) => {
        preview.status = {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
        throw error;
      })
      .finally(() => {
        preview.starting = undefined;
      });
    return preview.starting;
  }

  /** Runs a command in the project's preview (started if needed), as its user, in /app. */
  async exec(projectId: string, argv: string[], timeoutMs = 120_000) {
    await this.ensure(projectId);
    const preview = this.entry(projectId);
    preview.lastUsed = Date.now();
    // `ensure` checked the container runs, so a failure here is the command's own.
    return run(["docker", "exec", "-w", "/app", preview.name, ...argv], {
      timeoutMs,
    });
  }

  /** A directory of the project's preview, as a tar archive. */
  async copyOut(projectId: string, path: string) {
    await this.ensure(projectId);
    const preview = this.entry(projectId);
    const child = Bun.spawn(["docker", "cp", `${preview.name}:${path}`, "-"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [archive, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0)
      throw new Error(`Could not copy ${path} out: ${stderr.trim()}`);
    return new Uint8Array(archive);
  }

  /** The dev server's latest output. */
  async logs(projectId: string, lines = 80) {
    const preview = this.previews.get(projectId);
    if (!preview || preview.status.state === "stopped") return "";
    const { stdout, stderr } = await run([
      "docker",
      "logs",
      "--tail",
      String(lines),
      preview.name,
    ]);
    return (stdout + stderr).trim();
  }

  /** Errors the preview's page reported, newest last. */
  reportError(projectId: string, error: Omit<PreviewError, "at">) {
    const preview = this.entry(projectId);
    preview.errors.push({ ...error, at: new Date().toISOString() });
    if (preview.errors.length > MAX_ERRORS)
      preview.errors.splice(0, preview.errors.length - MAX_ERRORS);
  }

  errors(projectId: string) {
    return this.previews.get(projectId)?.errors ?? [];
  }

  clearErrors(projectId: string) {
    const preview = this.previews.get(projectId);
    if (preview) preview.errors = [];
  }

  private async remove(projectId: string) {
    const preview = this.previews.get(projectId);
    if (!preview) return;
    this.previews.delete(projectId);
    await run(["docker", "rm", "-f", preview.name]);
  }

  private async reap() {
    for (const [projectId, preview] of this.previews)
      if (
        preview.status.state !== "starting" &&
        Date.now() - preview.lastUsed > IDLE_MS
      )
        await this.remove(projectId);
  }
}
