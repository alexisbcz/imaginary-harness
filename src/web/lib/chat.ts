import { createClient } from "@/lib/supabase/client"

export type Thread = {
  id: string
  title: string
  updated_at: string
}

export type ChatMessage = {
  id: string
  thread_id: string
  role: "user" | "assistant"
  content: string
  status: "pending" | "streaming" | "done" | "failed"
  error: string | null
  created_at: string
}

/** Sends a user message; the agent picks it up through Realtime and streams its answer into `messages`. */
export async function sendMessage(threadId: string, content: string) {
  const { error } = await createClient().from("messages").insert({ thread_id: threadId, content })
  if (error) throw error
}

/** Creates a thread titled after its first message, then sends that message. */
export async function startThread(content: string) {
  const id = crypto.randomUUID()
  const title = content.replace(/\s+/g, " ").trim().slice(0, 60)
  const { error } = await createClient().from("threads").insert({ id, title })
  if (error) throw error
  await sendMessage(id, content)
  return id
}
