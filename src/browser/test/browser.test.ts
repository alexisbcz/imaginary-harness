import { describe, expect, it } from "bun:test";
import { capSnapshot } from "../agent.ts";
import { isPrivateHost } from "../sessions.ts";

describe("what the browser may reach", () => {
  it("keeps this machine, the private network and metadata services out", () => {
    for (const host of [
      "localhost", "app.localhost", "127.0.0.1", "10.0.0.5", "192.168.1.10", "172.17.0.1", "172.31.255.1",
      "169.254.169.254", "metadata.google.internal", "host.docker.internal", "printer.local", "100.64.0.1",
      "[::1]", "::1", "fd12:3456::1", "fe80::1", "0.0.0.0",
    ])
      expect(isPrivateHost(host)).toBe(true);
  });

  it("lets the public web through", () => {
    for (const host of ["techcrunch.com", "news.ycombinator.com", "172.32.0.1", "8.8.8.8", "github.com", "1.1.1.1"])
      expect(isPrivateHost(host)).toBe(false);
  });
});

describe("snapshots within the budget", () => {
  it("keeps short snapshots whole", () => {
    expect(capSnapshot("- button \"Go\" [ref=e1]", 100)).toBe("- button \"Go\" [ref=e1]");
  });

  it("cuts long ones at a line, saying how much is left", () => {
    const snapshot = Array.from({ length: 50 }, (_, i) => `- link "Item ${i}" [ref=e${i}]`).join("\n");
    const capped = capSnapshot(snapshot, 300);
    expect(capped.length).toBeLessThan(500);
    expect(capped.split("\n").slice(0, -1).every((line) => line.startsWith("- link"))).toBe(true);
    expect(capped).toMatch(/… \d+ more lines cut/);
  });
});
