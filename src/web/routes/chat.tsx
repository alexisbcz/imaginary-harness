import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useOutletContext, useParams } from "react-router";
import { AssistantAvatar } from "twenty-ui/components/data-display";
import { Chip } from "twenty-ui/primitives/data-display";
import { Tabs } from "twenty-ui/primitives/navigation";
import { Button } from "twenty-ui/primitives/input";
import {
  IconAlertTriangle,
  IconChevronRight,
  IconClick,
  IconMessageCircle,
  IconPlus,
} from "twenty-ui/icon";

import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  IconCode,
  IconDatabaseFilled,
  IconHistory,
  IconLayoutFilled,
  IconMessageCircleFilled,
} from "@tabler/icons-react";

import { BrowserPanel } from "@/components/browser-panel";
import { CodePanel } from "@/components/code-panel";
import { IconTile, NameTile } from "@/components/icon-tile";
import { IconMessageCircleFilled as IconChatTile, IconWorldWww } from "@tabler/icons-react";
import { DatabasePanel } from "@/components/database-panel";
import { CloneButton, PublishButton } from "@/components/ship-menu";
import { Composer, type PickedElement } from "@/components/composer";
import { HistoryPanel } from "@/components/history-panel";
import { Markdown } from "@/components/markdown";
import { PreviewPanel } from "@/components/preview-panel";
import { Steps } from "@/components/steps";
import { Page } from "@/components/page";
import { useWorkspaceFiles } from "@/components/workspace";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  attachmentUrl,
  MESSAGE_COLUMNS,
  renameChat,
  sendMessage,
  type ChatMessage,
} from "@/lib/chat";
import { EditableName } from "@/components/editable-name";
import { useIsMobile } from "@/hooks/use-mobile";
import { createClient } from "@/lib/supabase/client";
import { resources } from "@/locales";
import type { LayoutContext } from "@/routes/app-layout";

const supabase = createClient();

/** A thread's messages, the agent's streamed answers included, kept current through Realtime. */
export function useMessages(threadId: string) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);

  useEffect(() => {
    let active = true;
    setMessages(null);
    const upsert = (message: ChatMessage) =>
      setMessages((current) => {
        const list = current ?? [];
        const index = list.findIndex((item) => item.id === message.id);
        if (index === -1)
          return [...list, message].sort((a, b) =>
            a.created_at.localeCompare(b.created_at),
          );
        return list.map((item, i) => (i === index ? message : item));
      });
    const load = async () => {
      const { data } = await supabase
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("thread_id", threadId)
        .order("created_at");
      if (active && data) setMessages(data as ChatMessage[]);
    };
    const channel = supabase
      .channel(`thread:${threadId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `thread_id=eq.${threadId}`,
        },
        (payload) => {
          if (payload.eventType !== "DELETE")
            upsert(payload.new as ChatMessage);
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void load();
      });
    void load();
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [threadId]);

  return messages;
}

/** The images a message carries, fetched once. */
function MessageImages({ ids }: { ids: string[] }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    const created: string[] = [];
    Promise.all(ids.map((id) => attachmentUrl(id).catch(() => null))).then(
      (results) => {
        for (const url of results) if (url) created.push(url);
        if (active) setUrls(created);
      },
    );
    return () => {
      active = false;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [ids]);
  if (urls.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {urls.map((url) => (
        <img
          key={url}
          src={url}
          alt=""
          className="h-24 max-w-48 rounded-md border border-t-border object-cover"
        />
      ))}
    </div>
  );
}

/** The first line of a picked element's context, in every language: a message sent in either one reads back. */
const PICKED_PATTERNS = Object.values(resources).map(
  (language) =>
    new RegExp(
      "^" +
        language.builder.composer.picked.about
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace("\\{\\{tag\\}\\}", "([\\w-]+)")
          .replace("\\{\\{loc\\}\\}", "(\\S+)") +
        "\\n(?:.*\\n)*?\\n",
    ),
);

/** A message about a picked element starts with the element's context (see the composer): show it as a chip. */
function splitPicked(content: string) {
  let match: RegExpExecArray | null = null;
  for (const pattern of PICKED_PATTERNS) {
    match = pattern.exec(content);
    if (match) break;
  }
  if (!match) return { picked: null, text: content };
  return {
    picked: { tag: match[1]!, loc: match[2]! },
    text: content.slice(match[0].length),
  };
}

export function ChatBubble({ message }: { message: ChatMessage }) {
  const { t } = useTranslation("builder");
  if (message.role === "user") {
    const { picked, text } = splitPicked(message.content);
    return (
      <div className="flex flex-col items-end gap-1.5 pl-10">
        {message.attachments.length > 0 && (
          <MessageImages ids={message.attachments} />
        )}
        {picked && (
          <Chip
            variant="soft"
            size="sm"
            maxWidth={300}
            startElement={<IconClick size={12} />}
          >
            <span className="font-mono text-[11px]">
              &lt;{picked.tag}&gt; {picked.loc}
            </span>
          </Chip>
        )}
        {text && (
          <div className="rounded-lg bg-t-tertiary px-3 py-2 leading-[1.5] whitespace-pre-wrap text-t-text">
            {text}
          </div>
        )}
        {message.mode === "chat" && (
          <span className="flex items-center gap-1 text-[11px] text-t-text-light">
            <IconMessageCircle size={12} /> {t("chat.chatOnly")}
          </span>
        )}
      </div>
    );
  }
  const live = message.status === "streaming";
  return (
    <div className="flex gap-2.5">
      <AssistantAvatar
        size={20}
        shape="cookie"
        color="red"
        face={
          message.status === "failed" ? "surprised" : live ? "happy" : "default"
        }
        isAnimated={live}
        className="mt-px shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <Steps steps={message.steps} live={live} />
        {message.status === "failed" ? (
          <div className="flex items-start gap-2 rounded-md border border-[var(--t-border-color-danger)] bg-[var(--t-background-danger)] px-3 py-2 text-t-text-danger">
            <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{message.error ?? t("chat.noAnswer")}</span>
          </div>
        ) : message.content ? (
          <div className="min-w-0 leading-[1.6] text-t-text">
            <Markdown streaming={live}>{message.content}</Markdown>
          </div>
        ) : (
          live &&
          !message.steps.some((step) => step.status === "running") && (
            <Shimmer>{t("chat.thinking")}</Shimmer>
          )
        )}
      </div>
    </div>
  );
}

/** The messages of a chat and the box to write the next one. */
function Conversation({
  threadId,
  messages,
  modes = true,
  placeholder,
  picked = null,
  onClearPicked,
  empty,
}: {
  threadId: string;
  messages: ChatMessage[] | null;
  modes?: boolean;
  placeholder: string;
  picked?: PickedElement | null;
  onClearPicked?: () => void;
  /** Shown while the chat has no message yet. */
  empty?: React.ReactNode;
}) {
  const { t } = useTranslation("builder");
  const last = messages?.at(-1);
  // Waiting for the agent to pick the message up: the reply row does not exist yet.
  const waiting = last?.role === "user" && last.status === "pending";
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <MessageScrollerProvider>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-2xl gap-6 px-5 py-6">
              {messages?.length === 0 && empty}
              {messages?.map((message, index) => (
                <MessageScrollerItem
                  key={message.id}
                  scrollAnchor={index === messages.length - 1}
                >
                  <ChatBubble message={message} />
                </MessageScrollerItem>
              ))}
              {waiting && (
                <MessageScrollerItem>
                  <div className="flex items-center gap-2.5">
                    <AssistantAvatar
                      size={20}
                      shape="cookie"
                      color="red"
                      face="happy"
                      isAnimated
                    />
                    <Shimmer>{t("chat.thinking")}</Shimmer>
                  </div>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <div className="mx-auto w-full max-w-2xl px-3 pb-3">
        <Composer
          autoFocus
          modes={modes}
          placeholder={placeholder}
          picked={picked}
          onClearPicked={onClearPicked}
          onSend={(message) => sendMessage(threadId, message)}
        />
      </div>
    </div>
  );
}

/** A chat's name in a page's header, renamed in place. */
function ChatName({ id, title }: { id: string; title: string }) {
  const { t } = useTranslation("projects");
  return (
    <EditableName
      value={title}
      label={t("chat.rename")}
      maxLength={120}
      onRename={(name) => renameChat(id, name)}
      className="font-medium text-t-text"
      inputClassName="w-full max-w-[420px] font-medium"
    />
  );
}

/** A chat outside any project: a plain conversation with the agent, which builds nothing. */
export function PlainChat() {
  const { t } = useTranslation("projects");
  const { chatId } = useParams() as { chatId: string };
  const messages = useMessages(chatId);
  const { chats } = useOutletContext<LayoutContext>();
  const chat = chats?.find((item) => item.id === chatId);

  return (
    <Page
      title={chat ? <ChatName id={chat.id} title={chat.title} /> : ""}
      icon={
        <IconTile color="jade">
          <IconChatTile />
        </IconTile>
      }
    >
      <Conversation
        threadId={chatId}
        messages={messages}
        modes={false}
        placeholder={t("chat.placeholder")}
      />
    </Page>
  );
}

/** A chat of a project: the conversation that builds the project's app, and the app itself, live, with its code and its history. */
export function ProjectChat() {
  const { t } = useTranslation("builder");
  const { t: tp } = useTranslation("projects");
  const navigate = useNavigate();
  const { projectId, chatId } = useParams() as {
    projectId: string;
    chatId: string;
  };
  const messages = useMessages(chatId);
  const files = useWorkspaceFiles(projectId);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const isMobile = useIsMobile();
  const [tab, setTab] = useState(() =>
    window.innerWidth < 768 ? "chat" : "preview",
  );
  const { projects, chats } = useOutletContext<LayoutContext>();
  const project = projects?.find((item) => item.id === projectId);
  const chat = chats?.find((item) => item.id === chatId);

  const last = messages?.at(-1);
  const waiting = last?.role === "user" && last.status === "pending";
  const busy = waiting || last?.status === "streaming";
  const revision = files.reduce(
    (latest, file) => (file.updated_at > latest ? file.updated_at : latest),
    "",
  );

  useEffect(() => setPicked(null), [chatId]);

  // The agent opens the browser: show it, once per answer, so the user can still look elsewhere after.
  const shownBrowserFor = useRef<string | null>(null);
  const usesBrowser = last?.role === "assistant" && last.steps.some((step) => step.tool.startsWith("browser_"));
  useEffect(() => {
    if (!usesBrowser || !last || shownBrowserFor.current === last.id) return;
    shownBrowserFor.current = last.id;
    setTab("browser");
  }, [usesBrowser, last]);

  const onPicked = useCallback((element: PickedElement) => {
    setPicked(element);
  }, []);

  const conversation = (
    <Conversation
      threadId={chatId}
      messages={messages}
      placeholder={t("chat.placeholder")}
      picked={picked}
      onClearPicked={() => setPicked(null)}
    />
  );

  const tabs = [
    ...(isMobile
      ? [
          {
            value: "chat",
            label: t("chat.tabs.chat"),
            icon: IconMessageCircleFilled,
            color: "jade" as const,
          },
        ]
      : []),
    {
      value: "preview",
      label: t("chat.tabs.preview"),
      icon: IconLayoutFilled,
      color: "blue" as const,
    },
    { value: "code", label: t("chat.tabs.code"), icon: IconCode, color: "iris" as const },
    {
      value: "history",
      label: t("chat.tabs.history"),
      icon: IconHistory,
      color: "orange" as const,
    },
    {
      value: "database",
      label: t("chat.tabs.database"),
      icon: IconDatabaseFilled,
      color: "green" as const,
    },
    {
      value: "browser",
      label: t("chat.tabs.browser"),
      icon: IconWorldWww,
      color: "sky" as const,
    },
  ];

  // On a phone the conversation is one more tab; elsewhere it sits beside the workspace.
  const activeTab = !isMobile && tab === "chat" ? "preview" : tab;
  const workspace = (
    <Tabs.Root
      value={activeTab}
      onValueChange={(value) => setTab(String(value))}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex h-10 shrink-0 items-end">
        <Tabs.List
          aria-label={t("chat.views")}
          className="relative w-full overflow-x-auto px-3"
        >
          {tabs.map(({ value, label, icon: TabIcon, color }) => (
            <Tabs.Tab
              key={value}
              value={value}
              startIcon={
                <IconTile size="xs" color={color}>
                  <TabIcon />
                </IconTile>
              }
            >
              {label}
            </Tabs.Tab>
          ))}
          <Tabs.Indicator />
        </Tabs.List>
      </div>
      {isMobile && (
        <Tabs.Panel value="chat" className="min-h-0 flex-1">
          {conversation}
        </Tabs.Panel>
      )}
      {/* The preview stays mounted, so switching tabs does not reload the app. */}
      <Tabs.Panel
        value="preview"
        keepMounted
        className="min-h-0 flex-1 data-[hidden]:hidden"
      >
        <PreviewPanel
          projectId={projectId}
          hasFiles={files.length > 0}
          busy={busy}
          onPicked={onPicked}
          onFix={(errors) =>
            void sendMessage(chatId, {
              content: t("chat.fixPrompt", {
                count: errors.length,
                errors: errors.map((error) => `- ${error.message}`).join("\n"),
              }),
            })
          }
        />
      </Tabs.Panel>
      <Tabs.Panel value="code" className="min-h-0 flex-1">
        <CodePanel projectId={projectId} files={files} />
      </Tabs.Panel>
      <Tabs.Panel value="history" className="min-h-0 flex-1">
        <HistoryPanel projectId={projectId} revision={revision} />
      </Tabs.Panel>
      <Tabs.Panel value="database" className="min-h-0 flex-1">
        {/* The agent changes the database without touching files: reload as its answers move along. */}
        <DatabasePanel
          projectId={projectId}
          revision={`${revision}:${last?.id}:${last?.status}:${last?.steps?.length ?? 0}`}
        />
      </Tabs.Panel>
      <Tabs.Panel value="browser" className="min-h-0 flex-1">
        {activeTab === "browser" && (
          <BrowserPanel
            projectId={projectId}
            onDone={() => void sendMessage(chatId, { content: t("browser.doneMessage") })}
          />
        )}
      </Tabs.Panel>
    </Tabs.Root>
  );

  return (
    <Page
      title={
        <span className="flex min-w-0 items-center gap-1">
          <Link
            to={`/p/${projectId}`}
            className="max-w-[40%] shrink-0 truncate rounded-sm px-1 text-t-text-secondary outline-none hover:bg-t-hover hover:text-t-text focus-visible:ring-2 focus-visible:ring-ring"
          >
            {project?.name ?? ""}
          </Link>
          <IconChevronRight size={14} className="shrink-0 text-t-text-light" />
          {chat && <ChatName id={chat.id} title={chat.title} />}
        </span>
      }
      icon={project && <NameTile name={project.name} />}
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            startIcon={<IconPlus size={14} />}
            aria-label={tp("chat.newInProject")}
            onClick={() => void navigate(`/p/${projectId}`)}
          >
            {isMobile ? null : tp("chat.newChat")}
          </Button>
          {!isMobile && (
            <CloneButton projectId={projectId} disabled={files.length === 0} />
          )}
          <PublishButton projectId={projectId} disabled={files.length === 0} />
        </>
      }
    >
      {isMobile ? (
        workspace
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
        >
          <ResizablePanel defaultSize="36" minSize="25">
            {conversation}
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="64" minSize="30">
            {workspace}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </Page>
  );
}
