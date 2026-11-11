// The inbox's data: accounts, folders and messages read through Supabase (RLS) and followed through Realtime;
// flags and moves through the database's own functions; sending, drafts and setup through the mail API.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

export type MailAddress = { name: string; address: string };

export type MailAccount = {
  id: string;
  address: string;
  display_name: string;
  domain_id: string;
  assistant: "off" | "summarize" | "draft";
  catch_all: boolean;
};

export type SpecialUse =
  "inbox" | "sent" | "drafts" | "archive" | "junk" | "trash";

export type MailFolder = {
  id: string;
  account_id: string;
  name: string;
  special_use: SpecialUse | null;
};

export type MailListItem = {
  id: string;
  folder_id: string;
  flags: string[];
  subject: string;
  from_name: string;
  from_address: string;
  to_addresses: MailAddress[];
  snippet: string;
  summary: string | null;
  category: string | null;
  assistant_status: string | null;
  internal_date: string;
  sent_at: string | null;
  thread_key: string | null;
  attachments: { filename: string }[];
};

export type MailAttachment = {
  path: string;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
};

export type MailMessage = Omit<MailListItem, "attachments"> & {
  cc_addresses: MailAddress[];
  text_body: string;
  html_body: string | null;
  message_id: string | null;
  attachments: MailAttachment[];
  authentication: {
    spf?: string;
    dkim?: { result: string; domain?: string }[];
    dmarc?: { result: string; policy?: string; domain?: string } | null;
    internal?: boolean;
    tls?: string | null;
  } | null;
  delivery:
    | {
        address: string;
        status: string;
        detail: string;
        at: string;
        next?: string;
      }[]
    | null;
};

export type DnsRecord = {
  id: string;
  type: string;
  name: string;
  value: string;
  purpose: string;
  required: boolean;
  ok?: boolean;
  found?: string[];
  note?: string;
};

export type MailDomain = {
  id: string;
  name: string;
  user_id: string | null;
  open: boolean;
  dkim_selector: string;
  verified_at: string | null;
  checked_at?: string | null;
  checks: { checks?: DnsRecord[] } | Record<string, never>;
  records: DnsRecord[];
};

export type MailServer = {
  hostname: string;
  ports: {
    smtp: number;
    submission: number;
    submissions: number;
    imap: number;
    imaps: number;
  };
  tls: string;
  certificate: {
    issuer: string;
    expiresAt: string;
    names: string[];
    selfSigned: boolean;
  } | null;
  relay: string | null;
  addresses: string[];
  host: DnsRecord[];
};

const FOLDER_ORDER: Record<string, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  junk: 4,
  trash: 5,
};

const LIST_COLUMNS =
  "id, folder_id, flags, subject, from_name, from_address, to_addresses, snippet, summary, category, assistant_status, internal_date, sent_at, thread_key, attachments";

export const isUnread = (m: { flags: string[] }) => !m.flags.includes("\\Seen");
export const isFlagged = (m: { flags: string[] }) =>
  m.flags.includes("\\Flagged");

/** Re-runs `load` on every change to the given tables, and once at mount. */
function useLive(tables: string[], load: () => Promise<void>, key: string) {
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let timer: Timer | undefined;
    // Bursts of changes (a move of 50 messages) reload once.
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void loadRef.current(), 120);
    };
    let channel = supabase.channel(
      `mail-${key}-${Math.random().toString(36).slice(2)}`,
    );
    for (const table of tables)
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        reload,
      );
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") reload();
    });
    void loadRef.current();
    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [key, tables.join(",")]);
}

export function useMailAccounts() {
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const load = useCallback(async () => {
    const { data } = await supabase
      .from("mail_accounts")
      .select("id, address, display_name, domain_id, assistant, catch_all")
      .order("created_at");
    setAccounts((data as MailAccount[] | null) ?? []);
  }, []);
  useLive(["mail_accounts"], load, "accounts");
  return { accounts, reload: load };
}

export function useFolders(accountId: string | undefined) {
  const [folders, setFolders] = useState<MailFolder[] | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const load = useCallback(async () => {
    if (!accountId) return;
    const [{ data }, { data: unseen }] = await Promise.all([
      supabase
        .from("mail_folders")
        .select("id, account_id, name, special_use")
        .eq("account_id", accountId),
      supabase
        .from("mail_messages")
        .select("folder_id")
        .eq("account_id", accountId)
        .not("flags", "cs", '{"\\\\Seen"}')
        .limit(5000),
    ]);
    const list = ((data as MailFolder[] | null) ?? []).sort(
      (a, b) =>
        (FOLDER_ORDER[a.special_use ?? ""] ?? 9) -
          (FOLDER_ORDER[b.special_use ?? ""] ?? 9) ||
        a.name.localeCompare(b.name),
    );
    const counts: Record<string, number> = {};
    for (const row of (unseen as { folder_id: string }[] | null) ?? [])
      counts[row.folder_id] = (counts[row.folder_id] ?? 0) + 1;
    setFolders(list);
    setUnread(counts);
  }, [accountId]);
  useLive(["mail_folders", "mail_messages"], load, `folders-${accountId}`);
  return { folders, unread };
}

/** Unread mail across every address, for the sidebar. */
export function useUnreadCount() {
  const [count, setCount] = useState(0);
  const load = useCallback(async () => {
    const { data: inboxes } = await supabase
      .from("mail_folders")
      .select("id")
      .eq("special_use", "inbox");
    const ids = ((inboxes as { id: string }[] | null) ?? []).map((f) => f.id);
    if (ids.length === 0) return setCount(0);
    const { count } = await supabase
      .from("mail_messages")
      .select("id", { count: "exact", head: true })
      .in("folder_id", ids)
      .not("flags", "cs", '{"\\\\Seen"}');
    setCount(count ?? 0);
  }, []);
  useLive(["mail_messages"], load, "unread");
  return count;
}

export function useMessages(folderId: string | undefined, query: string) {
  const [messages, setMessages] = useState<MailListItem[] | null>(null);
  const load = useCallback(async () => {
    if (!folderId) return;
    let request = supabase
      .from("mail_messages")
      .select(LIST_COLUMNS)
      .eq("folder_id", folderId)
      .order("internal_date", { ascending: false })
      .limit(200);
    const q = query.trim().replace(/[%,()]/g, " ");
    if (q)
      request = request.or(
        `subject.ilike.%${q}%,from_name.ilike.%${q}%,from_address.ilike.%${q}%,snippet.ilike.%${q}%,summary.ilike.%${q}%`,
      );
    const { data } = await request;
    setMessages((data as MailListItem[] | null) ?? []);
  }, [folderId, query]);
  useEffect(() => setMessages(null), [folderId]);
  useLive(["mail_messages"], load, `messages-${folderId}-${query}`);
  return { messages, setMessages };
}

export function useMessage(id: string | undefined) {
  const [message, setMessage] = useState<MailMessage | null | undefined>(
    undefined,
  );
  const load = useCallback(async () => {
    if (!id) return setMessage(undefined);
    const { data } = await supabase
      .from("mail_messages")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    setMessage((data as MailMessage | null) ?? null);
  }, [id]);
  useEffect(() => setMessage(undefined), [id]);
  useLive(["mail_messages"], load, `message-${id}`);
  return message;
}

export async function setFlags(
  ids: string[],
  add: string[],
  remove: string[] = [],
) {
  const { error } = await supabase.rpc("mail_set_flags", {
    ids,
    add_flags: add,
    remove_flags: remove,
  });
  if (error) throw new Error(error.message);
}

export async function moveMessages(ids: string[], target: string) {
  const { error } = await supabase.rpc("mail_move", { ids, target });
  if (error) throw new Error(error.message);
}

export async function deleteMessages(ids: string[]) {
  const { error } = await supabase.from("mail_messages").delete().in("id", ids);
  if (error) throw new Error(error.message);
}

export async function updateAccount(
  id: string,
  values: Partial<
    Pick<MailAccount, "display_name" | "assistant" | "catch_all">
  >,
) {
  const { error } = await supabase
    .from("mail_accounts")
    .update(values)
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export type Draft = {
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  replyTo?: string;
  draftId?: string;
  attachments: {
    filename: string;
    contentType: string;
    data: string;
    size: number;
  }[];
};

export const sendMail = (draft: Draft & { key: string }) =>
  api<{ id: string; queued: string[]; local: string[] }>("/api/mail/send", {
    body: draft,
  });
export const saveDraft = (draft: Draft) =>
  api<{ id: string }>("/api/mail/drafts", { body: draft });

/** Downloads a file from the mail API (it needs the session's token, so a plain link will not do). */
export async function download(path: string, filename: string) {
  const { data } = await supabase.auth.getSession();
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}` },
  });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const formatAddress = (a: MailAddress) =>
  a.name ? `${a.name} <${a.address}>` : a.address;
export const senderName = (m: { from_name: string; from_address: string }) =>
  m.from_name || m.from_address.split("@")[0] || "Unknown sender";

/** Whether the sender is who they say: DMARC passed, or DKIM passed for the From domain. */
export function trust(
  message: MailMessage,
): "verified" | "unverified" | "failed" | "internal" {
  const auth = message.authentication;
  if (!auth) return "unverified";
  if (auth.internal) return "internal";
  if (auth.dmarc?.result === "pass") return "verified";
  if (auth.dmarc?.result === "fail" || auth.spf === "fail") return "failed";
  return "unverified";
}
