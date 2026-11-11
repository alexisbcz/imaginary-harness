import { useCallback, useEffect, useState } from "react";
import { useOutletContext, useParams } from "react-router";
import { AssistantAvatar } from "twenty-ui/components/data-display";
import { Chip } from "twenty-ui/primitives/data-display";
import { Tabs } from "twenty-ui/primitives/navigation";
import {
  IconAlertTriangle,
  IconClick,
  IconMessageCircle,
} from "twenty-ui/icon";

import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  IconCode,
  IconDatabaseFilled,
  IconHistory,
  IconLayoutFilled,
  IconMessageCircleFilled,
} from "@tabler/icons-react";

import { CodePanel } from "@/components/code-panel";
import { IconTile, NameTile } from "@/components/icon-tile";
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
  sendMessage,
  type ChatMessage,
} from "@/lib/chat";
import { useIsMobile } from "@/hooks/use-mobile";
import { createClient } from "@/lib/supabase/client";
import type { LayoutContext } from "@/routes/app-layout";

const supabase = createClient();

/** A thread's messages, the agent's streamed answers included, kept current through Realtime. */
function useMessages(threadId: string) {
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

/** A message about a picked element starts with the element's context (see the composer): show it as a chip. */
function splitPicked(content: string) {
  const match =
    /^About this element of the preview: <([\w-]+)> rendered at (\S+)\n(?:.*\n)*?\n/.exec(
      content,
    );
  if (!match) return { picked: null, text: content };
  return {
    picked: { tag: match[1]!, loc: match[2]! },
    text: content.slice(match[0].length),
  };
}

function ChatBubble({ message }: { message: ChatMessage }) {
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
            <IconMessageCircle size={12} /> Chat only
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
            <span>{message.error ?? "No answer"}</span>
          </div>
        ) : message.content ? (
          <div className="min-w-0 leading-[1.6] text-t-text">
            <Markdown streaming={live}>{message.content}</Markdown>
          </div>
        ) : (
          live &&
          !message.steps.some((step) => step.status === "running") && (
            <Shimmer>Thinking…</Shimmer>
          )
        )}
      </div>
    </div>
  );
}

/** A project: the conversation that builds it, and the app itself, live, with its code and its history. */
export function Chat() {
  const { threadId } = useParams() as { threadId: string };
  const messages = useMessages(threadId);
  const files = useWorkspaceFiles(threadId);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const isMobile = useIsMobile();
  const [tab, setTab] = useState(() =>
    window.innerWidth < 768 ? "chat" : "preview",
  );
  const { threads } = useOutletContext<LayoutContext>();
  const thread = threads?.find((item) => item.id === threadId);

  const last = messages?.at(-1);
  // Waiting for the agent to pick the message up: the reply row does not exist yet.
  const waiting = last?.role === "user" && last.status === "pending";
  const busy = waiting || last?.status === "streaming";
  const revision = files.reduce(
    (latest, file) => (file.updated_at > latest ? file.updated_at : latest),
    "",
  );

  useEffect(() => setPicked(null), [threadId]);

  const onPicked = useCallback((element: PickedElement) => {
    setPicked(element);
  }, []);

  const conversation = (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <MessageScrollerProvider>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-2xl gap-6 px-5 py-6">
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
                    <Shimmer>Thinking…</Shimmer>
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
          placeholder="Ask for a change…"
          picked={picked}
          onClearPicked={() => setPicked(null)}
          onSend={(message) => sendMessage(threadId, message)}
        />
      </div>
    </div>
  );

  const tabs = [
    ...(isMobile
      ? [
          {
            value: "chat",
            label: "Chat",
            icon: IconMessageCircleFilled,
            color: "jade" as const,
          },
        ]
      : []),
    {
      value: "preview",
      label: "Preview",
      icon: IconLayoutFilled,
      color: "blue" as const,
    },
    { value: "code", label: "Code", icon: IconCode, color: "iris" as const },
    {
      value: "history",
      label: "History",
      icon: IconHistory,
      color: "orange" as const,
    },
    {
      value: "database",
      label: "Database",
      icon: IconDatabaseFilled,
      color: "green" as const,
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
          aria-label="Project views"
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
          threadId={threadId}
          hasFiles={files.length > 0}
          busy={busy}
          onPicked={onPicked}
          onFix={(errors) =>
            void sendMessage(threadId, {
              content: `The preview shows ${errors.length === 1 ? "an error" : "errors"}. Find the cause and fix ${errors.length === 1 ? "it" : "them"}:\n\n${errors
                .map((error) => `- ${error.message}`)
                .join("\n")}`,
            })
          }
        />
      </Tabs.Panel>
      <Tabs.Panel value="code" className="min-h-0 flex-1">
        <CodePanel threadId={threadId} files={files} />
      </Tabs.Panel>
      <Tabs.Panel value="history" className="min-h-0 flex-1">
        <HistoryPanel threadId={threadId} revision={revision} />
      </Tabs.Panel>
      <Tabs.Panel value="database" className="min-h-0 flex-1">
        {/* The agent changes the database without touching files: reload as its answers move along. */}
        <DatabasePanel
          threadId={threadId}
          revision={`${revision}:${last?.id}:${last?.status}:${last?.steps?.length ?? 0}`}
        />
      </Tabs.Panel>
    </Tabs.Root>
  );

  return (
    <Page
      title={thread?.title ?? ""}
      icon={thread && <NameTile name={thread.title} />}
      actions={
        <>
          {!isMobile && (
            <CloneButton threadId={threadId} disabled={files.length === 0} />
          )}
          <PublishButton threadId={threadId} disabled={files.length === 0} />
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
