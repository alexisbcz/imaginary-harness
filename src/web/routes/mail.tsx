import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useRouteLoaderData } from "react-router";
import { format, isThisYear, isToday } from "date-fns";
import { cn } from "cn";
import { LightIconButton, SearchInput } from "twenty-ui/components/input";
import { Tag } from "twenty-ui/primitives/data-display";
import { Loader, Skeleton } from "twenty-ui/primitives/feedback";
import { Button, Input } from "twenty-ui/primitives/input";
import { ListItem } from "twenty-ui/primitives/navigation";
import {
  IconArchive,
  IconFlag,
  IconFolder,
  IconInbox,
  IconMail,
  IconPaperclip,
  IconPencil,
  IconSend,
  IconSettings,
  IconSparkles,
  IconTrash,
} from "twenty-ui/icon";
import { IconFileText, IconMailExclamation } from "@tabler/icons-react";

import { IconTile } from "@/components/icon-tile";
import { MailComposer } from "@/components/mail-composer";
import { MailReader } from "@/components/mail-reader";
import { Page } from "@/components/page";
import { SimpleSelect } from "@/components/simple-select";
import { useIsMobile } from "@/hooks/use-mobile";
import { api } from "@/lib/api";
import {
  deleteMessages,
  formatAddress,
  isFlagged,
  isUnread,
  moveMessages,
  senderName,
  setFlags,
  useFolders,
  useMailAccounts,
  useMessage,
  useMessages,
  type Draft,
  type MailAccount,
  type MailFolder,
  type MailListItem,
  type MailMessage,
} from "@/lib/mail";
import { createClient } from "@/lib/supabase/client";

const FOLDER_ICONS: Record<string, React.ReactNode> = {
  inbox: <IconInbox />,
  drafts: <IconFileText />,
  sent: <IconSend />,
  archive: <IconArchive />,
  junk: <IconMailExclamation />,
  trash: <IconTrash />,
};

const shortDate = (iso: string) => {
  const date = new Date(iso);
  return isToday(date)
    ? format(date, "HH:mm")
    : isThisYear(date)
      ? format(date, "d MMM")
      : format(date, "d MMM yyyy");
};

function MessageRow({
  message,
  selected,
  sent,
  onOpen,
}: {
  message: MailListItem;
  selected: boolean;
  sent: boolean;
  onOpen: () => void;
}) {
  const unread = isUnread(message);
  const who = sent
    ? `To ${message.to_addresses.map((a) => a.name || a.address).join(", ")}`
    : senderName(message);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full flex-col gap-0.5 border-b border-t-border-light px-3 py-2.5 text-left outline-none focus-visible:bg-t-hover",
        selected ? "bg-[var(--t-color-blue3)]" : "hover:bg-t-hover",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            unread ? "bg-[var(--t-color-blue9)]" : "bg-transparent",
          )}
          aria-hidden
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            unread ? "font-semibold text-t-text" : "text-t-text-secondary",
          )}
        >
          {who}
        </span>
        {isFlagged(message) && (
          <IconFlag
            size={12}
            className="shrink-0 fill-current text-[var(--t-color-orange10)]"
            aria-label="Flagged"
          />
        )}
        {message.attachments.length > 0 && (
          <IconPaperclip
            size={12}
            className="shrink-0 text-t-text-tertiary"
            aria-label="Has attachments"
          />
        )}
        <time className="shrink-0 text-[11px] text-t-text-tertiary tabular-nums">
          {shortDate(message.sent_at ?? message.internal_date)}
        </time>
      </div>
      <div
        className={cn(
          "truncate pl-3.5",
          unread ? "font-medium text-t-text" : "text-t-text-secondary",
        )}
      >
        {message.subject || "(no subject)"}
      </div>
      <div className="flex items-center gap-1.5 pl-3.5">
        {message.summary && (
          <IconSparkles
            size={12}
            className="shrink-0 text-[var(--t-color-blue10)]"
            aria-label="Summary"
          />
        )}
        <span className="line-clamp-1 min-w-0 flex-1 text-[12px] text-t-text-tertiary">
          {message.summary ?? message.snippet}
        </span>
        {message.category && message.category !== "other" && (
          <Tag color="gray" variant="soft" className="shrink-0 text-[10px]">
            {message.category}
          </Tag>
        )}
      </div>
    </button>
  );
}

/** First visit: take an address on one of the server's open domains, or bring your own domain. */
function Onboarding({ name }: { name: string }) {
  const [domains, setDomains] = useState<{ id: string; name: string }[] | null>(
    null,
  );
  const [domain, setDomain] = useState("");
  const [local, setLocal] = useState(
    name
      .toLowerCase()
      .split(" ")[0]
      ?.replace(/[^a-z0-9._-]/g, "") ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    void createClient()
      .from("mail_domains")
      .select("id, name")
      .order("name")
      .then(({ data }) => {
        setDomains(data ?? []);
        if (data?.[0]) setDomain(data[0].name);
      });
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api("/api/mail/accounts", {
        body: { domain, localPart: local, displayName: name },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pt-[12vh] pb-16">
      <div className="flex w-full max-w-[480px] flex-col gap-5">
        <IconTile color="blue" size="lg">
          <IconMail />
        </IconTile>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[22px] leading-tight font-semibold text-t-text">
            Your inbox, with an assistant
          </h1>
          <p className="text-t-text-tertiary">
            Mail lives in Richelieu&rsquo;s database. The agent summarizes what
            arrives and can draft replies, and any mail app can connect over
            IMAP.
          </p>
        </div>
        {domains === null ? (
          <Skeleton width="100%" height={32} />
        ) : domains.length > 0 ? (
          <form onSubmit={create} className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
              <Input
                size="md"
                aria-label="Address"
                value={local}
                onChange={(e) => setLocal(e.target.value.toLowerCase())}
                placeholder="ada"
                className="min-w-0 flex-1"
                required
              />
              <span className="text-t-text-tertiary">@</span>
              {domains.length > 1 ? (
                <SimpleSelect
                  label="Domain"
                  value={domain}
                  onValueChange={setDomain}
                  options={domains.map((d) => ({
                    value: d.name,
                    label: d.name,
                  }))}
                  className="w-auto"
                />
              ) : (
                <span className="font-medium text-t-text">{domain}</span>
              )}
            </div>
            {error && (
              <p className="text-[12px] text-[var(--t-color-red11)]">{error}</p>
            )}
            <Button
              type="submit"
              variant="solid"
              color="accent"
              loading={creating}
            >
              Create my address
            </Button>
          </form>
        ) : (
          <p className="rounded-md bg-t-tertiary px-3 py-2 text-t-text-secondary">
            This server has no mail domain yet. Add your own below, or ask its
            operator to run <code>bun run mail setup</code>.
          </p>
        )}
        <Link
          to="/mail/settings"
          className="text-t-text-secondary underline decoration-t-border-strong underline-offset-[3px] hover:text-t-text"
        >
          Use your own domain instead
        </Link>
      </div>
    </div>
  );
}

function quoted(message: MailMessage) {
  const when = format(
    new Date(message.sent_at ?? message.internal_date),
    "d MMM yyyy 'at' HH:mm",
  );
  return `\n\nOn ${when}, ${formatAddress({ name: message.from_name, address: message.from_address })} wrote:\n${message.text_body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n")}`;
}

export function Mail() {
  const { name } = useRouteLoaderData("app") as { name: string };
  const { folderId, messageId } = useParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { accounts } = useMailAccounts();
  const [accountId, setAccountId] = useState<string | undefined>();
  const account: MailAccount | undefined =
    accounts?.find((a) => a.id === accountId) ?? accounts?.[0];
  const { folders, unread } = useFolders(account?.id);
  const folder: MailFolder | undefined =
    folders?.find((f) => f.id === folderId) ??
    folders?.find((f) => f.special_use === "inbox");
  const [query, setQuery] = useState("");
  const { messages } = useMessages(folder?.id, query);
  const message = useMessage(messageId);
  const [composing, setComposing] = useState<Partial<Draft> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Opening a message marks it read.
  useEffect(() => {
    if (message && isUnread(message)) void setFlags([message.id], ["\\Seen"]);
  }, [message?.id]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const go = (folder: string | undefined, message?: string) =>
    void navigate(
      message
        ? `/mail/${folder}/${message}`
        : folder
          ? `/mail/${folder}`
          : "/mail",
    );

  // The next message to show when the current one leaves the list.
  const neighbour = useMemo(() => {
    if (!messages || !messageId) return undefined;
    const i = messages.findIndex((m) => m.id === messageId);
    return messages[i + 1] ?? messages[i - 1];
  }, [messages, messageId]);

  async function act(run: () => Promise<void>, done: string) {
    try {
      await run();
      setNotice(done);
      if (!isMobile && neighbour) go(folder?.id, neighbour.id);
      else go(folder?.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function reply(mode: "reply" | "all" | "forward") {
    if (!message || !account) return;
    if (mode === "forward")
      return setComposing({
        from: account.id,
        subject: /^fwd?:/i.test(message.subject)
          ? message.subject
          : `Fwd: ${message.subject}`,
        text: `\n\n---------- Forwarded message ----------\nFrom: ${formatAddress({ name: message.from_name, address: message.from_address })}\nDate: ${format(new Date(message.sent_at ?? message.internal_date), "d MMM yyyy, HH:mm")}\nSubject: ${message.subject}\nTo: ${message.to_addresses.map(formatAddress).join(", ")}\n\n${message.text_body}`,
      });
    const own = new Set(accounts?.map((a) => a.address));
    const sentByMe = own.has(message.from_address);
    const to = sentByMe
      ? message.to_addresses
      : [{ name: message.from_name, address: message.from_address }];
    const cc =
      mode === "all"
        ? [...message.to_addresses, ...message.cc_addresses].filter(
            (a) =>
              !own.has(a.address) && !to.some((t) => t.address === a.address),
          )
        : [];
    setComposing({
      from:
        accounts?.find((a) =>
          message.to_addresses.some((t) => t.address === a.address),
        )?.id ?? account.id,
      to: to.map(formatAddress).join(", "),
      cc: cc.map(formatAddress).join(", "),
      subject: /^re:/i.test(message.subject)
        ? message.subject
        : `Re: ${message.subject}`,
      text: quoted(message),
      replyTo: message.id,
    });
  }

  async function openDraft(id: string) {
    const { data } = await createClient()
      .from("mail_messages")
      .select("*")
      .eq("id", id)
      .single();
    const draft = data as MailMessage | null;
    if (!draft) return;
    setComposing({
      from: account?.id,
      to: draft.to_addresses.map(formatAddress).join(", "),
      cc: draft.cc_addresses.map(formatAddress).join(", "),
      subject: draft.subject,
      text: draft.text_body.replace(/\r\n/g, "\n").trimEnd(),
      draftId: draft.id,
    });
  }

  if (accounts === null)
    return (
      <Page
        title="Mail"
        icon={
          <IconTile color="blue">
            <IconMail />
          </IconTile>
        }
      >
        <div className="flex flex-1 items-center justify-center">
          <Loader />
        </div>
      </Page>
    );
  if (accounts.length === 0)
    return (
      <Page
        title="Mail"
        icon={
          <IconTile color="blue">
            <IconMail />
          </IconTile>
        }
        actions={<SettingsLink />}
      >
        <Onboarding name={name} />
      </Page>
    );

  const showList = !isMobile || !messageId;
  const showReader = !isMobile || !!messageId;
  const isDrafts = folder?.special_use === "drafts";

  return (
    <Page
      title={account?.address ?? "Mail"}
      icon={
        <IconTile color="blue">
          <IconMail />
        </IconTile>
      }
      actions={
        <>
          {accounts.length > 1 && (
            <SimpleSelect
              label="Address"
              value={account!.id}
              onValueChange={(id) => {
                setAccountId(id);
                go(undefined);
              }}
              options={accounts.map((a) => ({ value: a.id, label: a.address }))}
            />
          )}
          <Button
            size="sm"
            variant="solid"
            color="accent"
            startIcon={<IconPencil size={14} />}
            shortcut={isMobile ? undefined : ["C"]}
            onClick={() => setComposing({ from: account?.id })}
          >
            Write
          </Button>
          <SettingsLink />
        </>
      }
      bodyClassName="flex-row"
    >
      {!isMobile && (
        <nav
          aria-label="Folders"
          className="flex w-[188px] shrink-0 flex-col gap-px overflow-y-auto border-r border-t-border-light p-2"
        >
          {folders === null
            ? Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} width="80%" height={12} className="my-2" />
              ))
            : folders.map((f) => (
                <ListItem
                  key={f.id}
                  render={<Link to={`/mail/${f.id}`} />}
                  selected={f.id === folder?.id}
                  startIcon={
                    <span className="flex text-t-text-tertiary [&_svg]:size-4">
                      {FOLDER_ICONS[f.special_use ?? ""] ?? <IconFolder />}
                    </span>
                  }
                  description={
                    unread[f.id] &&
                    f.special_use !== "trash" &&
                    f.special_use !== "sent" ? (
                      <span className="tabular-nums">{unread[f.id]}</span>
                    ) : undefined
                  }
                  descriptionPlacement="end"
                >
                  {f.special_use === "inbox" ? "Inbox" : f.name}
                </ListItem>
              ))}
        </nav>
      )}

      {showList && (
        <section
          aria-label="Messages"
          className={cn(
            "flex min-h-0 flex-col border-r border-t-border-light",
            isMobile ? "flex-1" : "w-[min(380px,36%)] shrink-0",
          )}
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-t-border-light px-2">
            {isMobile && folders && (
              <SimpleSelect
                label="Folder"
                value={folder?.id ?? ""}
                onValueChange={(id) => go(id)}
                options={folders.map((f) => ({
                  value: f.id,
                  label:
                    f.special_use === "inbox"
                      ? `Inbox${unread[f.id] ? ` (${unread[f.id]})` : ""}`
                      : f.name,
                }))}
              />
            )}
            <SearchInput
              size="sm"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1"
              aria-label="Search mail"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {messages === null &&
              Array.from({ length: 8 }, (_, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-1.5 border-b border-t-border-light px-3 py-3"
                >
                  <Skeleton width="45%" height={10} />
                  <Skeleton width="80%" height={10} />
                </div>
              ))}
            {messages?.length === 0 && (
              <p className="px-4 py-10 text-center text-t-text-tertiary">
                {query
                  ? "Nothing matches."
                  : folder?.special_use === "inbox"
                    ? `Nothing here yet. Mail sent to ${account?.address} lands here.`
                    : "No messages."}
              </p>
            )}
            {messages?.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                sent={
                  folder?.special_use === "sent" ||
                  folder?.special_use === "drafts"
                }
                selected={m.id === messageId}
                onOpen={() =>
                  isDrafts ? void openDraft(m.id) : go(folder?.id, m.id)
                }
              />
            ))}
          </div>
        </section>
      )}

      {showReader && (
        <section aria-label="Message" className="flex min-w-0 flex-1 flex-col">
          {messageId ? (
            <MailReader
              message={message}
              folder={folder}
              folders={folders ?? []}
              onBack={isMobile ? () => go(folder?.id) : undefined}
              onReply={reply}
              onMove={(target) =>
                void act(
                  () => moveMessages([messageId], target.id),
                  `Moved to ${target.special_use === "inbox" ? "Inbox" : target.name}`,
                )
              }
              onDelete={() => {
                const trash = folders?.find((f) => f.special_use === "trash");
                if (folder?.special_use === "trash" || !trash)
                  void act(() => deleteMessages([messageId]), "Deleted");
                else
                  void act(
                    () => moveMessages([messageId], trash.id),
                    "Moved to Trash",
                  );
              }}
              onToggleFlag={() =>
                message &&
                void setFlags(
                  [message.id],
                  isFlagged(message) ? [] : ["\\Flagged"],
                  isFlagged(message) ? ["\\Flagged"] : [],
                )
              }
              onMarkUnread={() =>
                void act(
                  () => setFlags([messageId], [], ["\\Seen"]),
                  "Marked as unread",
                )
              }
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-t-text-tertiary">
              <IconMail size={28} className="opacity-40" />
              {messages?.length ? "Pick a message to read it." : ""}
            </div>
          )}
        </section>
      )}

      <MailComposer
        open={composing !== null}
        onOpenChange={(open) => !open && setComposing(null)}
        accounts={accounts}
        initial={composing ?? {}}
        onSent={(result) =>
          setNotice(
            result.queued.length ? "Sent. Delivery shows in Sent." : "Sent",
          )
        }
      />
      <ComposeShortcut
        onCompose={() => setComposing({ from: account?.id })}
        disabled={composing !== null}
      />
      {notice && (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-md bg-[var(--t-color-gray12)] px-3 py-1.5 text-[13px] text-[var(--t-color-gray1)] shadow-lg"
        >
          {notice}
        </div>
      )}
    </Page>
  );
}

function SettingsLink() {
  return (
    <LightIconButton
      aria-label="Mail settings"
      tooltip="Mail settings"
      nativeButton={false}
      render={<Link to="/mail/settings" />}
    >
      <IconSettings size={16} />
    </LightIconButton>
  );
}

/** `c` writes a new message, as in most mail apps, unless typing somewhere. */
function ComposeShortcut({
  onCompose,
  disabled,
}: {
  onCompose: () => void;
  disabled: boolean;
}) {
  useEffect(() => {
    if (disabled) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key !== "c" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (
        target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
      )
        return;
      event.preventDefault();
      onCompose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCompose, disabled]);
  return null;
}
