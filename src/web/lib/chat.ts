import i18n from "@/lib/i18n";
import { createClient } from "@/lib/supabase/client";

/** A chat: a conversation with the agent, in a project (which it builds) or on its own. */
export type Thread = {
  id: string;
  title: string;
  updated_at: string;
  project_id: string | null;
};

// i18n-ignore: database columns
export const THREAD_COLUMNS = "id, title, updated_at, project_id";

/** Where a chat opens: inside its project, or on its own. */
export function chatPath(chat: Pick<Thread, "id" | "project_id">) {
  return chat.project_id ? `/p/${chat.project_id}/c/${chat.id}` : `/c/${chat.id}`;
}

export type Step = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  summary?: string;
};

export type Mode = "build" | "chat";

export type ChatMessage = {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "streaming" | "done" | "failed";
  error: string | null;
  steps: Step[];
  mode: Mode;
  attachments: string[];
  created_at: string;
};

export const MESSAGE_COLUMNS =
  // i18n-ignore: database columns
  "id, thread_id, role, content, status, error, steps, mode, attachments, created_at";

/** Longest side of an attached image, in pixels: enough for a screenshot to be read, small enough to send. */
const MAX_IMAGE_SIDE = 1600;

/** Shrinks an image to `MAX_IMAGE_SIDE` and re-encodes it, as a PNG when it has transparency to keep, else JPEG. */
async function shrink(file: File) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(
    1,
    MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height),
  );
  const canvas = new OffscreenCanvas(
    Math.round(bitmap.width * scale),
    Math.round(bitmap.height * scale),
  );
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await canvas.convertToBlob({ type, quality: 0.85 });
  return { blob, type };
}

/** Uploads an image for a message of the thread; returns the attachment's id. */
export async function uploadImage(threadId: string, file: File) {
  const { blob, type } = await shrink(file);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let hex = "\\x";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  const id = crypto.randomUUID();
  const { error } = await createClient()
    .from("attachments")
    .insert({ id, thread_id: threadId, mime_type: type, data: hex });
  if (error) throw error;
  return id;
}

/** An attachment as an object URL, for showing it. */
export async function attachmentUrl(id: string) {
  const { data, error } = await createClient()
    .from("attachments")
    .select("mime_type, data")
    .eq("id", id)
    .single();
  if (error) throw error;
  const hex = (data.data as string).replace(/^\\x/, "");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return URL.createObjectURL(new Blob([bytes], { type: data.mime_type }));
}

export type Outgoing = {
  content: string;
  mode?: Mode;
  /** Images to upload with the message. */
  images?: File[];
};

/** Sends a user message; the agent picks it up through Realtime and streams its answer into `messages`. */
export async function sendMessage(threadId: string, message: Outgoing) {
  const supabase = createClient();
  const attachments = await Promise.all(
    (message.images ?? []).map((file) => uploadImage(threadId, file)),
  );
  const { error } = await supabase.from("messages").insert({
    thread_id: threadId,
    content: message.content,
    mode: message.mode ?? "build",
    attachments,
  });
  if (error) throw error;
  // Deployed, the agent is a function: wake it now rather than at the next cron tick. It answers whatever is
  // pending, so the request carries nothing.
  void fetch("/api/agent", { method: "POST", keepalive: true }).catch(() => {});
}

/** A short name from a message: its first words, on one line. */
export function nameFrom(content: string, fallback: string, length = 60) {
  const line = content.replace(/\s+/g, " ").trim();
  if (line.length <= length) return line || fallback;
  const cut = line.slice(0, length);
  const space = cut.lastIndexOf(" ");
  return `${(space > length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Starts a chat named after its first message, in a project or on its own, then sends that message. */
export async function startChat(message: Outgoing, projectId: string | null = null) {
  const id = crypto.randomUUID();
  const title = nameFrom(message.content, i18n.t("common:sections.newChat"));
  const { error } = await createClient()
    .from("threads")
    .insert({ id, title, project_id: projectId });
  if (error) throw error;
  await sendMessage(id, message);
  return chatPath({ id, project_id: projectId });
}

export async function renameChat(id: string, title: string) {
  const { error } = await createClient()
    .from("threads")
    .update({ title: title.trim().slice(0, 120) })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteChat(id: string) {
  const { error } = await createClient().from("threads").delete().eq("id", id);
  if (error) throw error;
}
