import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { createSandbox, dockerAvailable } from "./sandbox.ts";

const docker = await dockerAvailable();

/** A stand-in for Postgres: one thread, conversation 1, whose workspace holds `files`. */
function fakeSql(files: Record<string, string>) {
  return ((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM public.threads"))
      return Promise.resolve([{ id: "thread" }]);
    if (query.includes("FROM public.files"))
      return Promise.resolve(
        Object.entries(files).map(([path, contents]) => ({ path, contents })),
      );
    throw new Error(`Unexpected query: ${query}`);
  }) as unknown as SQL;
}

async function runCommand(
  files: Record<string, string>,
  args: { command: string; runtime?: string; timeout_seconds?: number },
) {
  const tool = createSandbox(fakeSql(files)).tools![0]!;
  const result = await tool.execute(
    args as never,
    { conversationId: 1 } as never,
    undefined as never,
  );
  const [first] = result.output as { type: "text"; text: string }[];
  return { text: first!.text, isError: result.isError ?? false };
}

test.skipIf(!docker)(
  "runs a workspace script and returns its output",
  async () => {
    const result = await runCommand(
      {
        "main.py": "from lib.greet import greet\nprint(greet('bud'))\n",
        "lib/greet.py": "def greet(name):\n    return f'hey {name}'\n",
      },
      { command: "python main.py" },
    );
    expect(result).toEqual({ text: "Exit code 0\nhey bud", isError: false });
  },
  60_000,
);

test.skipIf(!docker)(
  "reports a failing command as an error, with its stderr",
  async () => {
    const result = await runCommand(
      {},
      { command: "node -e \"throw new Error('boom')\"", runtime: "node" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toStartWith("Exit code 1");
    expect(result.text).toContain("boom");
  },
  60_000,
);

test.skipIf(!docker)(
  "has no network",
  async () => {
    const result = await runCommand(
      {},
      {
        command:
          "python -c \"import urllib.request; urllib.request.urlopen('https://example.com', timeout=5)\"",
      },
    );
    expect(result.isError).toBe(true);
  },
  60_000,
);

test.skipIf(!docker)(
  "stops a command at its timeout",
  async () => {
    const result = await runCommand(
      {},
      { command: "sleep 30", timeout_seconds: 2 },
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toStartWith("Timed out after 2s");
  },
  60_000,
);
