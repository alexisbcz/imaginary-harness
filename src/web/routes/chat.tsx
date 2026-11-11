import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { IconCodeComments } from "@pierre/icons";

import { Shimmer } from "@/components/ai-elements/shimmer";
import { CodePanel } from "@/components/code-panel";
import { Composer, type PickedElement } from "@/components/composer";
import { HistoryPanel } from "@/components/history-panel";
import { Markdown } from "@/components/markdown";
import { PreviewPanel } from "@/components/preview-panel";
import { Steps } from "@/components/steps";
import { useWorkspaceFiles } from "@/components/workspace";
import {
  Attachment,
  AttachmentGroup,
  AttachmentMedia,
} from "@/components/ui/attachment";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  attachmentUrl,
  MESSAGE_COLUMNS,
  sendMessage,
  type ChatMessage,
} from "@/lib/chat";
import { createClient } from "@/lib/supabase/client";

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
    <AttachmentGroup className="justify-end">
      {urls.map((url) => (
        <Attachment key={url} orientation="vertical" size="sm">
          <AttachmentMedia variant="image">
            <img src={url} alt="" />
          </AttachmentMedia>
        </Attachment>
      ))}
    </AttachmentGroup>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <Message align="end">
        <MessageContent className="items-end gap-2">
          {message.attachments.length > 0 && (
            <MessageImages ids={message.attachments} />
          )}
          {message.content && (
            <Bubble variant="secondary">
              <BubbleContent className="whitespace-pre-wrap">
                {message.content}
              </BubbleContent>
            </Bubble>
          )}
          {message.mode === "chat" && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <IconCodeComments className="size-3.5" /> Chat only
            </span>
          )}
        </MessageContent>
      </Message>
    );
  }
  const live = message.status === "streaming";
  return (
    <Message>
      <MessageContent className="w-full gap-3">
        <Steps steps={message.steps} live={live} />
        {message.status === "failed" ? (
          <Bubble variant="destructive">
            <BubbleContent>{message.error ?? "No answer"}</BubbleContent>
          </Bubble>
        ) : message.content ? (
          <Bubble variant="ghost" className="w-full">
            <BubbleContent className="w-full">
              <Markdown streaming={live}>{message.content}</Markdown>
            </BubbleContent>
          </Bubble>
        ) : (
          live &&
          !message.steps.some((step) => step.status === "running") && (
            <Shimmer>Thinking…</Shimmer>
          )
        )}
      </MessageContent>
    </Message>
  );
}

/** A project: the conversation that builds it, and the app itself, live, with its code and its history. */
export function Chat() {
  const { threadId } = useParams() as { threadId: string };
  const messages = useMessages(threadId);
  const files = useWorkspaceFiles(threadId);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [tab, setTab] = useState("preview");

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
            <MessageScrollerContent className="mx-auto w-full max-w-2xl gap-6 px-4 py-6">
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
                  <Shimmer>Thinking…</Shimmer>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <div className="mx-auto w-full max-w-2xl px-4 pb-4">
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

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize="36" minSize="25">
        {conversation}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize="64" minSize="30">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(String(value))}
          className="flex h-full min-h-0 flex-col gap-0"
        >
          <div className="flex h-11 shrink-0 items-center border-b px-2">
            <TabsList>
              <TabsTrigger value="preview">Preview</TabsTrigger>
              <TabsTrigger value="code">Code</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
          </div>
          {/* The preview stays mounted, so switching tabs does not reload the app. */}
          <TabsContent
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
          </TabsContent>
          <TabsContent value="code" className="min-h-0 flex-1">
            <CodePanel threadId={threadId} files={files} />
          </TabsContent>
          <TabsContent value="history" className="min-h-0 flex-1">
            <HistoryPanel threadId={threadId} revision={revision} />
          </TabsContent>
        </Tabs>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
