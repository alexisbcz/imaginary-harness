import { useEffect, useState } from "react"
import { useParams } from "react-router"

import { Composer } from "@/components/composer"
import { Markdown } from "@/components/markdown"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageContent } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Spinner } from "@/components/ui/spinner"
import { sendMessage, type ChatMessage } from "@/lib/chat"
import { createClient } from "@/lib/supabase/client"

const supabase = createClient()

/** A thread's messages, the agent's streamed answers included, kept current through Realtime. */
function useMessages(threadId: string) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null)

  useEffect(() => {
    let active = true
    setMessages(null)
    const upsert = (message: ChatMessage) =>
      setMessages((current) => {
        const list = current ?? []
        const index = list.findIndex((item) => item.id === message.id)
        if (index === -1) return [...list, message].sort((a, b) => a.created_at.localeCompare(b.created_at))
        return list.map((item, i) => (i === index ? message : item))
      })
    const load = async () => {
      const { data } = await supabase
        .from("messages")
        .select("id, thread_id, role, content, status, error, created_at")
        .eq("thread_id", threadId)
        .order("created_at")
      if (active && data) setMessages(data)
    }
    const channel = supabase
      .channel(`thread:${threadId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `thread_id=eq.${threadId}` },
        (payload) => {
          if (payload.eventType !== "DELETE") upsert(payload.new as ChatMessage)
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void load()
      })
    void load()
    return () => {
      active = false
      void supabase.removeChannel(channel)
    }
  }, [threadId])

  return messages
}

function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <Message align="end">
        <MessageContent>
          <Bubble variant="secondary">
            <BubbleContent className="whitespace-pre-wrap">{message.content}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    )
  }
  if (message.status === "failed") {
    return (
      <Message>
        <MessageContent>
          <Bubble variant="destructive">
            <BubbleContent>{message.error ?? "No answer"}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    )
  }
  return (
    <Message>
      <MessageContent>
        <Bubble variant="ghost" className="w-full">
          <BubbleContent className="w-full">
            {message.content ? <Markdown>{message.content}</Markdown> : <Spinner className="text-muted-foreground" />}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}

export function Chat() {
  const { threadId } = useParams() as { threadId: string }
  const messages = useMessages(threadId)
  const last = messages?.at(-1)
  // Waiting for the agent to pick the message up: the reply row does not exist yet.
  const waiting = last?.role === "user" && last.status === "pending"

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageScrollerProvider>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-2xl gap-6 px-4 py-6">
              {messages?.map((message, index) => (
                <MessageScrollerItem key={message.id} scrollAnchor={index === messages.length - 1}>
                  <ChatBubble message={message} />
                </MessageScrollerItem>
              ))}
              {waiting && (
                <MessageScrollerItem>
                  <Spinner className="text-muted-foreground" />
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <div className="mx-auto w-full max-w-2xl px-4 pb-4">
        <Composer autoFocus onSend={(content) => sendMessage(threadId, content)} />
      </div>
    </div>
  )
}
