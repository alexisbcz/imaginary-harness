import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { cn } from "cn";
import { LightIconButton } from "twenty-ui/components/input";
import { Tag } from "twenty-ui/primitives/data-display";
import { Skeleton } from "twenty-ui/primitives/feedback";
import { Button } from "twenty-ui/primitives/input";
import {
  IconAlertTriangle,
  IconArchive,
  IconArrowBackUp,
  IconArrowLeft,
  IconCircleCheck,
  IconClock,
  IconDownload,
  IconFlag,
  IconInbox,
  IconPaperclip,
  IconSparkles,
  IconTrash,
} from "twenty-ui/icon";
import {
  IconMailOpened,
  IconShieldCheck,
  IconShieldX,
} from "@tabler/icons-react";

import { NameTile } from "@/components/icon-tile";
import {
  download,
  formatAddress,
  isFlagged,
  senderName,
  trust,
  type MailFolder,
  type MailMessage,
} from "@/lib/mail";

const kb = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * An HTML email in a sandboxed frame: no scripts, nothing fetched from the network unless the reader asks for
 * images, links opening in a new tab. The frame grows with its content.
 */
function HtmlBody({ html, showImages }: { html: string; showImages: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  const doc = useMemo(() => {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: cid:${showImages ? " https: http:" : ""}`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{margin:0;padding:16px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:#1f1f1f;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}blockquote{margin:0 0 0 8px;padding-left:12px;border-left:2px solid #ddd;color:#555}</style></head><body>${html}</body></html>`;
  }, [html, showImages]);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => {
      const body = element.contentDocument?.body;
      if (body) setHeight(Math.min(20_000, body.scrollHeight + 4));
    };
    element.addEventListener("load", measure);
    const timer = setInterval(measure, 500);
    setTimeout(() => clearInterval(timer), 5000);
    return () => {
      element.removeEventListener("load", measure);
      clearInterval(timer);
    };
  }, [doc]);
  return (
    <iframe
      ref={frame}
      title="Message"
      // allow-same-origin without allow-scripts: the frame runs no code, and the page can measure it.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      style={{ height }}
      className="w-full rounded-md border border-t-border-light bg-white"
    />
  );
}

/** Quoted replies fold away under a "…" toggle, as in most mail apps. */
function TextBody({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const quoteStart = lines.findIndex(
    (line, i) =>
      /^On .+wrote:$/.test(line.trim()) ||
      (line.startsWith(">") &&
        lines.slice(i).every((l) => l.startsWith(">") || !l.trim())),
  );
  const main =
    quoteStart > 0 && !expanded
      ? lines.slice(0, quoteStart).join("\n").trimEnd()
      : text;
  return (
    <div className="px-1">
      <div className="whitespace-pre-wrap break-words text-[14px] leading-[1.6] text-t-text">
        {main}
      </div>
      {quoteStart > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 rounded-sm bg-t-tertiary px-2 text-t-text-tertiary hover:bg-t-hover"
          aria-label={expanded ? "Hide quoted text" : "Show quoted text"}
        >
          ···
        </button>
      )}
    </div>
  );
}

function TrustBadge({ message }: { message: MailMessage }) {
  const level = trust(message);
  const domain = message.from_address.split("@")[1];
  if (level === "verified")
    return (
      <span
        className="inline-flex items-center gap-1 text-[12px] text-[var(--t-color-green11)]"
        title={`SPF, DKIM and DMARC vouch for ${domain}`}
      >
        <IconShieldCheck size={14} /> Verified sender
      </span>
    );
  if (level === "failed")
    return (
      <span
        className="inline-flex items-center gap-1 text-[12px] text-[var(--t-color-red11)]"
        title="The sender's domain did not vouch for this message"
      >
        <IconShieldX size={14} /> Could not verify {domain}
      </span>
    );
  return null;
}

function Delivery({ message }: { message: MailMessage }) {
  if (!message.delivery?.length) return null;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-t-border-light bg-t-secondary px-3 py-2">
      {message.delivery.map((d) => (
        <div key={d.address} className="flex items-center gap-2 text-[12px]">
          {d.status === "sent" ? (
            <IconCircleCheck
              size={14}
              className="text-[var(--t-color-green11)]"
            />
          ) : d.status === "failed" ? (
            <IconAlertTriangle
              size={14}
              className="text-[var(--t-color-red11)]"
            />
          ) : (
            <IconClock size={14} className="text-[var(--t-color-amber11)]" />
          )}
          <span className="font-medium text-t-text">{d.address}</span>
          <span className="truncate text-t-text-tertiary" title={d.detail}>
            {d.status === "sent"
              ? "Delivered"
              : d.status === "failed"
                ? `Not delivered: ${d.detail}`
                : d.status === "retrying"
                  ? `Retrying${d.next ? ` at ${format(new Date(d.next), "HH:mm")}` : ""}: ${d.detail}`
                  : "Sending…"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function MailReader({
  message,
  folder,
  folders,
  onBack,
  onReply,
  onMove,
  onDelete,
  onToggleFlag,
  onMarkUnread,
}: {
  message: MailMessage | null | undefined;
  folder: MailFolder | undefined;
  folders: MailFolder[];
  onBack?: () => void;
  onReply: (mode: "reply" | "all" | "forward") => void;
  onMove: (target: MailFolder) => void;
  onDelete: () => void;
  onToggleFlag: () => void;
  onMarkUnread: () => void;
}) {
  const [showImages, setShowImages] = useState(false);
  useEffect(() => setShowImages(false), [message?.id]);

  if (message === undefined)
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton width="60%" height={18} />
        <Skeleton width="35%" height={12} />
        <Skeleton width="100%" height={120} />
      </div>
    );
  if (message === null)
    return (
      <div className="flex flex-1 items-center justify-center text-t-text-tertiary">
        This message is gone.
      </div>
    );

  const special = (use: string) => folders.find((f) => f.special_use === use);
  const archive = special("archive");
  const inbox = special("inbox");
  const isJunk = folder?.special_use === "junk";
  const isTrash = folder?.special_use === "trash";
  const hasRemoteImages =
    !!message.html_body && /<img[^>]+src=["']?https?:/i.test(message.html_body);
  const attachments = message.attachments.filter(
    (a) => !a.inline || !message.html_body,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-t-border-light px-2">
        {onBack && (
          <LightIconButton aria-label="Back to the list" onClick={onBack}>
            <IconArrowLeft size={16} />
          </LightIconButton>
        )}
        <LightIconButton
          aria-label="Reply"
          tooltip="Reply"
          onClick={() => onReply("reply")}
        >
          <IconArrowBackUp size={16} />
        </LightIconButton>
        {archive && folder?.id !== archive.id && (
          <LightIconButton
            aria-label="Archive"
            tooltip="Archive"
            onClick={() => onMove(archive)}
          >
            <IconArchive size={16} />
          </LightIconButton>
        )}
        {(isJunk || isTrash || folder?.special_use === "archive") && inbox && (
          <LightIconButton
            aria-label="Move to the inbox"
            tooltip={isJunk ? "Not junk" : "Move to the inbox"}
            onClick={() => onMove(inbox)}
          >
            <IconInbox size={16} />
          </LightIconButton>
        )}
        <LightIconButton
          aria-label={isTrash ? "Delete forever" : "Delete"}
          tooltip={isTrash ? "Delete forever" : "Delete"}
          onClick={onDelete}
        >
          <IconTrash size={16} />
        </LightIconButton>
        <LightIconButton
          aria-label="Mark as unread"
          tooltip="Mark as unread"
          onClick={onMarkUnread}
        >
          <IconMailOpened size={16} />
        </LightIconButton>
        <LightIconButton
          aria-label={isFlagged(message) ? "Unflag" : "Flag"}
          tooltip={isFlagged(message) ? "Unflag" : "Flag"}
          onClick={onToggleFlag}
        >
          <IconFlag
            size={16}
            className={cn(
              isFlagged(message) &&
                "fill-current text-[var(--t-color-orange10)]",
            )}
          />
        </LightIconButton>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => onReply("all")}>
          Reply all
        </Button>
        <Button size="sm" variant="outline" onClick={() => onReply("forward")}>
          Forward
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-5 sm:px-6">
          <h1 className="text-[20px] leading-snug font-semibold text-balance text-t-text">
            {message.subject || "(no subject)"}
          </h1>
          <div className="flex items-start gap-3">
            <NameTile name={senderName(message)} round size="md" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold text-t-text">
                  {senderName(message)}
                </span>
                <span className="truncate text-t-text-tertiary">
                  {message.from_address}
                </span>
              </div>
              <div className="truncate text-[12px] text-t-text-tertiary">
                to{" "}
                {message.to_addresses.map(formatAddress).join(", ") ||
                  "undisclosed recipients"}
                {message.cc_addresses.length > 0 &&
                  `, cc ${message.cc_addresses.map(formatAddress).join(", ")}`}
              </div>
              <TrustBadge message={message} />
            </div>
            <time
              className="shrink-0 text-[12px] text-t-text-tertiary"
              dateTime={message.sent_at ?? message.internal_date}
            >
              {format(
                new Date(message.sent_at ?? message.internal_date),
                "d MMM yyyy, HH:mm",
              )}
            </time>
          </div>

          {message.summary && (
            <div className="flex gap-2 rounded-md border border-t-border-light bg-t-secondary px-3 py-2">
              <IconSparkles
                size={16}
                className="mt-0.5 shrink-0 text-[var(--t-color-blue10)]"
              />
              <p className="text-t-text-secondary">
                {message.summary}
                {message.category && (
                  <Tag
                    color="blue"
                    variant="soft"
                    className="ml-2 align-middle"
                  >
                    {message.category}
                  </Tag>
                )}
              </p>
            </div>
          )}

          <Delivery message={message} />

          {hasRemoteImages && !showImages && (
            <div className="flex items-center justify-between gap-2 rounded-md bg-t-tertiary px-3 py-1.5 text-[12px] text-t-text-secondary">
              Images are hidden, so the sender cannot tell you opened this.
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowImages(true)}
              >
                Show images
              </Button>
            </div>
          )}

          {message.html_body ? (
            <HtmlBody html={message.html_body} showImages={showImages} />
          ) : (
            <TextBody text={message.text_body} />
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((a) => (
                <button
                  key={a.path}
                  type="button"
                  onClick={() =>
                    void download(
                      `/api/mail/messages/${message.id}/parts/${a.path}`,
                      a.filename,
                    )
                  }
                  className="flex max-w-[260px] items-center gap-2 rounded-md border border-t-border px-2.5 py-1.5 text-left hover:bg-t-hover"
                >
                  <IconPaperclip
                    size={14}
                    className="shrink-0 text-t-text-tertiary"
                  />
                  <span className="min-w-0 flex-1 truncate text-t-text">
                    {a.filename}
                  </span>
                  <span className="shrink-0 text-[11px] text-t-text-tertiary">
                    {kb(a.size)}
                  </span>
                  <IconDownload
                    size={14}
                    className="shrink-0 text-t-text-tertiary"
                  />
                </button>
              ))}
            </div>
          )}

          <div className="flex gap-2 pt-2 pb-6">
            <Button
              size="sm"
              variant="outline"
              startIcon={<IconArrowBackUp size={14} />}
              onClick={() => onReply("reply")}
            >
              Reply
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void download(
                  `/api/mail/messages/${message.id}/raw`,
                  `${(message.subject || "message").slice(0, 60)}.eml`,
                )
              }
            >
              Download .eml
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
