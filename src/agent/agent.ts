// The agent, wired to Supabase: new user messages arrive through Realtime, Pi Durable answers them on its
// Postgres storage, and the answer streams back into `public.messages`, which the app follows through Realtime.

import type { SQL } from "bun";
import type { Context } from "@earendil-works/chord/context";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  AssistantEntry,
  type Conversation,
  type ConversationId,
  type Harness,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { config } from "../config.ts";

type MessageRow = {
  id: string;
  thread_id: string;
  user_id: string;
  content: string;
};

/** How often a streamed answer is written to its row at most. */
const STREAM_INTERVAL_MS = 150;
/** Pending messages are swept this often too, should a Realtime event be missed. */
const SWEEP_INTERVAL_MS = 30_000;

const INSTRUCTIONS = `You are Richelieu, a helpful assistant. Answer in the user's language. Use Markdown when it helps.`;

/** The text parts of an assistant message as pi-ai represents it. */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: { type?: string; text?: string }) =>
      part.type === "text" && part.text ? [part.text] : [],
    )
    .join("");
}

export class Agent {
  private readonly supabase: SupabaseClient;
  /** Each thread's messages are answered in order, one at a time. */
  private readonly threads = new Map<string, Promise<void>>();
  private readonly seen = new Set<string>();
  private sweeper: Timer | undefined;

  constructor(
    private readonly sql: SQL,
    private readonly harness: Harness,
    private readonly context: Context,
  ) {
    this.supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /** Follows new user messages and answers the ones a previous process left pending. */
  start() {
    this.harness.resume();
    this.supabase
      .channel("agent")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: "role=eq.user",
        },
        (payload) => this.enqueue(payload.new as MessageRow),
      )
      .subscribe((status, error) => {
        if (status === "SUBSCRIBED") void this.sweep();
        else if (error)
          console.error(`[agent] realtime ${status}:`, error.message);
      });
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
  }

  /** Stops following messages. Answers underway end with the Harness; their messages stay pending until the next start. */
  async stop() {
    clearInterval(this.sweeper);
    await this.supabase.removeAllChannels();
  }

  /**
   * Answers every pending message, then returns: the serverless mode, where a cron or a ping starts a run instead
   * of Realtime. Stops picking up messages at `deadline`; an answer cut short stays pending for the next run.
   */
  async drain(deadline: number) {
    this.harness.resume();
    while (Date.now() < deadline) {
      await this.sweep();
      if (this.threads.size === 0) return;
      await Promise.race([
        Promise.allSettled([...this.threads.values()]),
        Bun.sleep(Math.max(0, deadline - Date.now())),
      ]);
    }
  }

  private async sweep() {
    const rows = await this.sql<MessageRow[]>`
      SELECT id, thread_id, user_id, content FROM public.messages
      WHERE role = 'user' AND status = 'pending' ORDER BY created_at`;
    for (const row of rows) this.enqueue(row);
  }

  private enqueue(message: MessageRow) {
    if (this.seen.has(message.id)) return;
    this.seen.add(message.id);
    const previous = this.threads.get(message.thread_id) ?? Promise.resolve();
    const next = previous
      .then(() => this.answer(message))
      .catch((error) => console.error(`[agent] message ${message.id}:`, error))
      .finally(() => {
        this.seen.delete(message.id);
        if (this.threads.get(message.thread_id) === next)
          this.threads.delete(message.thread_id);
      });
    this.threads.set(message.thread_id, next);
  }

  private async answer(message: MessageRow) {
    const [current] = await this
      .sql`SELECT status FROM public.messages WHERE id = ${message.id}`;
    if (current?.status !== "pending") return;

    const conversation = await this.conversationOf(message.thread_id);
    const [reply] = await this.sql<{ id: string }[]>`
      INSERT INTO public.messages (thread_id, user_id, role, status, reply_to)
      VALUES (${message.thread_id}, ${message.user_id}, 'assistant', 'streaming', ${message.id})
      ON CONFLICT (reply_to) DO UPDATE SET status = 'streaming', error = NULL
      RETURNING id`;
    const replyId = reply!.id;

    // The message ID is the request ID: after a crash, submitting again finds the same submission.
    const submission = await conversation.submit(
      { type: "input", content: message.content, requestId: message.id },
      this.context,
    );
    const stopStreaming = await this.stream(conversation, replyId);
    const settled = await submission.wait(this.context).finally(stopStreaming);

    if (settled.status === "done" && settled.type === "input") {
      const answer = await conversation.commit(
        (tx) => tx.entry(AssistantEntry, settled.answer),
        this.context,
      );
      const text = textOf(answer?.model?.[0]);
      await this.sql.begin(async (tx) => {
        await tx`UPDATE public.messages SET content = ${text}, status = 'done' WHERE id = ${replyId}`;
        await tx`UPDATE public.messages SET status = 'done' WHERE id = ${message.id}`;
      });
    } else {
      const reason =
        "reason" in settled ? String(settled.reason) : settled.status;
      await this.sql.begin(async (tx) => {
        await tx`UPDATE public.messages SET status = 'failed', error = ${reason} WHERE id = ${replyId}`;
        await tx`UPDATE public.messages SET status = 'failed', error = ${reason} WHERE id = ${message.id}`;
      });
    }
  }

  /** The thread's Pi conversation, created with the thread's first message. */
  private async conversationOf(threadId: string): Promise<Conversation> {
    const [thread] = await this.sql<{ conversation_id: string | null }[]>`
      SELECT conversation_id FROM public.threads WHERE id = ${threadId}`;
    if (thread === undefined) throw new Error(`Unknown thread ${threadId}`);
    if (thread.conversation_id !== null) {
      const existing = await this.harness.conversation(
        Number(thread.conversation_id) as ConversationId,
        this.context,
      );
      if (existing !== undefined) return existing;
    }
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: config.model, instructions: INSTRUCTIONS },
      },
      this.context,
    );
    await this
      .sql`UPDATE public.threads SET conversation_id = ${conversation.id} WHERE id = ${threadId}`;
    return conversation;
  }

  /** Writes the running generation's partial answer to the reply row, throttled. Returns the stop function. */
  private async stream(
    conversation: Conversation,
    replyId: string,
  ): Promise<() => Promise<void>> {
    let latest = "";
    let written = "";
    let writing = Promise.resolve();
    const flush = () => {
      const text = latest;
      if (text === written) return;
      written = text;
      writing = writing
        .then(async () => {
          await this
            .sql`UPDATE public.messages SET content = ${text} WHERE id = ${replyId} AND status = 'streaming'`;
        })
        .catch((error) => console.error("[agent] stream:", error));
    };
    const timer = setInterval(flush, STREAM_INTERVAL_MS);
    const watch = await conversation.watch(this.context, { min: 1, max: 2 });
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      const live = call.value.docs["pi.live"] as
        (JsonObject & { generation?: { message?: unknown } }) | undefined;
      const text = textOf(live?.generation?.message);
      if (text) latest = text;
    });
    return async () => {
      clearInterval(timer);
      await watch.stop();
      await writing;
    };
  }
}
