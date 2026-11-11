// A sandbox for the agent to run code: each call starts a throwaway Docker container holding a copy of the thread's
// workspace, runs one shell command in it without network, and returns its output. Nothing it changes outlives the
// call; the agent keeps a result by writing it to the workspace with write_file.

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SQL } from "bun";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";

/** The images a command can run in, each with its language's usual tools. */
const IMAGES = {
  python: "python:3.13-slim",
  node: "node:22-slim",
  bun: "oven/bun:1-slim",
} as const;
type Runtime = keyof typeof IMAGES;

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
/** First pulls of an image can take a while; they do not count against the command's timeout. */
const PULL_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARACTERS = 20_000;

/** Whether this machine can start containers; on Vercel's functions it cannot, and the tool stays off. */
export async function dockerAvailable(): Promise<boolean> {
  if (!Bun.which("docker")) return false;
  const info = Bun.spawn(["docker", "info", "--format", "{{.ServerVersion}}"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await info.exited) === 0;
}

/** Keeps the head and the tail of a long output, where the command line and its error usually are. */
function clip(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARACTERS) return output;
  const half = MAX_OUTPUT_CHARACTERS / 2;
  return `${output.slice(0, half)}\n… ${output.length - MAX_OUTPUT_CHARACTERS} characters cut …\n${output.slice(-half)}`;
}

async function run(argv: string[], timeoutMs: number) {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearTimeout(timer));
  return { stdout, stderr, exitCode, timedOut };
}

async function ensureImage(image: string) {
  const inspect = await run(["docker", "image", "inspect", image], 30_000);
  if (inspect.exitCode === 0) return;
  const pull = await run(["docker", "pull", "--quiet", image], PULL_TIMEOUT_MS);
  if (pull.exitCode !== 0)
    throw new Error(`Could not pull ${image}: ${pull.stderr.trim()}`);
}

export function createSandbox(sql: SQL) {
  const runCommand = defineTool({
    name: "run_command",
    description:
      "Run a shell command in a fresh, isolated container that holds a copy of the workspace at /workspace (the " +
      "working directory), and get its exit code and output. Use it to run, test or check code you wrote. The " +
      "container has no network, so packages cannot be installed: stick to the standard library. Files the command " +
      "creates or changes are thrown away with the container; save results with write_file.",
    parameters: obj({
      command: str({
        description: "A shell command, like `python main.py` or `node --test`",
      }),
      runtime: opt(
        oneOf(Object.keys(IMAGES) as Runtime[], {
          description:
            "The container's toolchain: python (3.13, the default), node (22) or bun",
        }),
      ),
      timeout_seconds: opt(
        int({
          minimum: 1,
          maximum: MAX_TIMEOUT_SECONDS,
          description: `Seconds before the command is stopped; default ${DEFAULT_TIMEOUT_SECONDS}`,
        }),
      ),
    }),
    // The container starts from the workspace each time and reaches nothing outside it, so a rerun is harmless.
    replay: "safe",
    execute: async (args, api) => {
      const [thread] = await sql<{ id: string }[]>`
        SELECT id FROM public.threads WHERE conversation_id = ${api.conversationId}`;
      if (thread === undefined)
        throw new Error("This conversation has no workspace");
      const files = await sql<{ path: string; contents: string }[]>`
        SELECT path, contents FROM public.files WHERE thread_id = ${thread.id}`;

      const image = IMAGES[args.runtime ?? "python"];
      await ensureImage(image);

      const directory = await mkdtemp(join(tmpdir(), "richelieu-sandbox-"));
      const name = `richelieu-sandbox-${crypto.randomUUID()}`;
      try {
        const workspace = join(directory, "workspace");
        await mkdir(workspace);
        for (const file of files) {
          // Paths come from the workspace, which only holds relative paths without `..`.
          const target = join(workspace, file.path);
          await mkdir(dirname(target), { recursive: true });
          await Bun.write(target, file.contents);
        }

        const timeoutSeconds = args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
        const result = await run(
          [
            "docker",
            "run",
            "--rm",
            "--name",
            name,
            "--network",
            "none",
            "--memory",
            "512m",
            "--cpus",
            "1",
            "--pids-limit",
            "256",
            "--security-opt",
            "no-new-privileges",
            "--cap-drop",
            "ALL",
            "--volume",
            `${workspace}:/workspace`,
            "--workdir",
            "/workspace",
            image,
            "sh",
            "-c",
            args.command,
          ],
          timeoutSeconds * 1000,
        );
        if (result.timedOut) {
          // Killing the CLI leaves the container running; stop it for good.
          await run(["docker", "rm", "--force", name], 30_000);
        }

        const output = clip(
          [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
        );
        const status = result.timedOut
          ? `Timed out after ${timeoutSeconds}s`
          : `Exit code ${result.exitCode}`;
        return {
          output: [
            {
              type: "text" as const,
              text: `${status}\n${output || "(no output)"}`,
            },
          ],
          isError: result.timedOut || result.exitCode !== 0,
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  });

  return defineExtension({
    name: "sandbox",
    tools: [runCommand],
    sections: [
      section(
        "sandbox",
        () =>
          "You can run code with run_command, in a container holding a copy of the workspace. When you write a " +
          "script or a program, run it to check it works before you say it does, and show what it printed. Write " +
          "the files first: the container sees only what the workspace holds.",
      ),
    ],
  });
}
