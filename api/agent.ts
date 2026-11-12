// Vercel function: answers pending messages, then exits. The web app pings it after sending a message, and a cron
// runs it every minute, so an answer a timeout cut short resumes. Pi Durable's writer lock keeps runs one at a time.

import { openAgent } from "../src/agent/runtime.ts";
import { sharedServices } from "../src/server/services.ts";

/** Keep in step with vercel.json's maxDuration, leaving time to close cleanly. */
const BUDGET_MS = 270_000;

export default {
  async fetch() {
    const started = Date.now();
    const { sql, storage } = await sharedServices();
    let opened: Awaited<ReturnType<typeof openAgent>>;
    try {
      opened = await openAgent(sql, storage, { lockTimeoutMs: 2_000 });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Another process holds")
      ) {
        return Response.json({ status: "busy" }, { status: 202 }); // a run is underway and will pick the message up
      }
      throw error;
    }
    try {
      await opened.agent.drain(started + BUDGET_MS);
      // New mail waits for the assistant too; what a run leaves over, the next one reads.
      await opened.assistant.drain(started + BUDGET_MS);
      // The cron's minute is also when scheduled newsletter posts and Notes go out.
      await opened.newsletterService
        .publishDue()
        .catch((error) => console.warn("[newsletter] scheduler:", error));
    } finally {
      await opened.close();
    }
    return Response.json({ status: "done", ms: Date.now() - started });
  },
};
