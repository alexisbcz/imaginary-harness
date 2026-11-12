// A newsletter's copilot: the conversation beside the posts and the editor. It is a thread of its own (kind
// 'newsletter'), answered by the agent with the newsletter tools only; what it drafts lands in Substack, and the
// open views reload as its answers move along.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AssistantAvatar } from "twenty-ui/components/data-display";
import { LightIconButton } from "twenty-ui/components/input";
import { IconX } from "twenty-ui/icon";

import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Composer } from "@/components/composer";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { sendMessage } from "@/lib/chat";
import type { Newsletter } from "@/lib/newsletter";
import { ChatBubble, useMessages } from "@/routes/chat";

function suggestionsFor(t: TFunction<"newsletter">, newsletter: Newsletter, postId: number | null) {
  if (postId)
    return [
      t("copilot.suggestions.review", { id: postId }),
      t("copilot.suggestions.opening", { id: postId }),
      t("copilot.suggestions.paywall", { id: postId }),
      t("copilot.suggestions.notesFor", { id: postId }),
    ];
  const thin = !newsletter.description && !newsletter.voice;
  const suggestions: (string | null)[] = [
    thin && newsletter.connected_at ? t("copilot.suggestions.briefFromPosts") : thin ? t("copilot.suggestions.briefInterview") : null,
    newsletter.connected_at ? t("copilot.suggestions.bestPosts") : null,
    t("copilot.suggestions.brainstorm"),
    t("copilot.suggestions.nextDraft"),
    t("copilot.suggestions.weekNotes"),
  ];
  return suggestions.filter((s): s is string => Boolean(s));
}

export function NewsletterCopilot({
  newsletter,
  postId,
  onActivity,
  onClose,
}: {
  newsletter: Newsletter;
  /** The post open in the editor, which suggestions talk about. */
  postId: number | null;
  onActivity: (revision: string) => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation("newsletter");
  const threadId = newsletter.thread_id!;
  const messages = useMessages(threadId);
  const last = messages?.at(-1);
  const waiting = last?.role === "user" && last.status === "pending";
  const done = last?.role === "assistant" ? last.steps.filter((s) => s.status !== "running").length : 0;

  useEffect(() => {
    if (last) onActivity(`${last.id}:${last.status}:${done}`);
  }, [last?.id, last?.status, done, onActivity, last]);

  const send = (content: string) => sendMessage(threadId, { content });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-t-border-light px-3">
        <AssistantAvatar size={16} shape="cookie" color="orange" face="happy" />
        <span className="min-w-0 flex-1 truncate font-medium text-t-text">{t("copilot.title")}</span>
        {onClose && (
          <LightIconButton aria-label={t("copilot.close")} size="sm" onClick={onClose}>
            <IconX size={16} />
          </LightIconButton>
        )}
      </div>
      <MessageScrollerProvider>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-2xl gap-6 px-4 py-5">
              {messages?.length === 0 && (
                <MessageScrollerItem>
                  <div className="flex flex-col gap-4 pt-6">
                    <AssistantAvatar size={40} shape="cookie" color="orange" face="happy" />
                    <div className="flex flex-col gap-1">
                      <p className="text-[15px] font-semibold text-t-text">{t("copilot.heading", { name: newsletter.name })}</p>
                      <p className="leading-[1.55] text-t-text-secondary">
                        {t("copilot.intro")}
                      </p>
                    </div>
                    <Suggestions className="items-start">
                      {suggestionsFor(t, newsletter, postId).map((suggestion) => (
                        <Suggestion
                          key={suggestion}
                          suggestion={suggestion}
                          onClick={(text) => void send(text)}
                          className="h-auto min-h-8 max-w-full py-1.5 text-left whitespace-normal"
                        />
                      ))}
                    </Suggestions>
                  </div>
                </MessageScrollerItem>
              )}
              {messages?.map((message, index) => (
                <MessageScrollerItem key={message.id} scrollAnchor={index === messages.length - 1}>
                  <ChatBubble message={message} />
                </MessageScrollerItem>
              ))}
              {waiting && (
                <MessageScrollerItem>
                  <div className="flex items-center gap-2.5">
                    <AssistantAvatar size={20} shape="cookie" color="orange" face="happy" isAnimated />
                    <Shimmer>{t("copilot.thinking")}</Shimmer>
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
          modes={false}
          placeholder={postId ? t("copilot.askAboutDraft", { id: postId }) : t("copilot.ask")}
          onSend={(message) => sendMessage(threadId, message)}
        />
      </div>
    </div>
  );
}
