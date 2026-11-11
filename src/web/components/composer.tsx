import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import {
  IconButton,
  LightIconButton,
  SegmentedControl,
} from "twenty-ui/components/input";
import { Chip } from "twenty-ui/primitives/data-display";
import { Textarea } from "twenty-ui/primitives/input";
import {
  IconArrowUp,
  IconClick,
  IconTool,
  IconMessageCircle,
  IconPhoto,
  IconX,
} from "twenty-ui/icon";

import type { Mode, Outgoing } from "@/lib/chat";

/** An element the user picked in the preview, to ask a change about. */
export type PickedElement = {
  loc: string;
  tag: string;
  text: string;
  className: string;
};

const MAX_IMAGES = 6;

/** What the agent reads about a picked element, before the user's request. */
function withPicked(content: string, picked: PickedElement | null) {
  if (!picked) return content;
  const lines = [
    `About this element of the preview: <${picked.tag}> rendered at ${picked.loc}`,
    picked.text && `Its text: "${picked.text}"`,
    picked.className && `Its classes: ${picked.className}`,
  ].filter(Boolean);
  return `${lines.join("\n")}\n\n${content}`;
}

/** The message box: Enter sends, Shift+Enter adds a line; images can be pasted, dropped or picked. */
export function Composer({
  onSend,
  disabled = false,
  autoFocus = false,
  placeholder = "Ask Richelieu…",
  picked = null,
  onClearPicked,
  value: controlledValue,
  onValueChange,
}: {
  onSend: (message: Outgoing) => Promise<void>;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  picked?: PickedElement | null;
  onClearPicked?: () => void;
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  const [ownValue, setOwnValue] = useState("");
  const value = controlledValue ?? ownValue;
  const setValue = onValueChange ?? setOwnValue;
  const [images, setImages] = useState<{ file: File; url: string }[]>([]);
  const [mode, setMode] = useState<Mode>("build");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const content = value.trim();
  const canSend =
    (content.length > 0 || images.length > 0) && !sending && !disabled;

  // Picking an element is a cue to type: bring the cursor here.
  // The pick was a click inside the preview's iframe, which keeps focus once its handler returns: take it back after.
  useEffect(() => {
    if (!picked) return;
    const timer = setTimeout(() => {
      window.focus();
      textarea.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [picked]);

  useEffect(
    () => () => images.forEach((image) => URL.revokeObjectURL(image.url)),
    // Only on unmount: removed images are revoked as they go.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function addFiles(files: Iterable<File>) {
    const added = [...files]
      .filter((file) => file.type.startsWith("image/"))
      .map((file) => ({ file, url: URL.createObjectURL(file) }));
    if (added.length === 0) return;
    setImages((current) => [...current, ...added].slice(0, MAX_IMAGES));
  }

  function removeImage(url: string) {
    URL.revokeObjectURL(url);
    setImages((current) => current.filter((image) => image.url !== url));
  }

  async function send() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await onSend({
        content: withPicked(content, picked),
        mode,
        images: images.map((image) => image.file),
      });
      setValue("");
      images.forEach((image) => URL.revokeObjectURL(image.url));
      setImages([]);
      onClearPicked?.();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not send the message",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragging(false);
        addFiles(event.dataTransfer.files);
      }}
    >
      <div
        className={cn(
          "flex cursor-text flex-col rounded-lg border border-t-border bg-t-primary shadow-[0_2px_4px_rgb(0_0_0/0.04),0_0_1px_rgb(0_0_0/0.04)] transition-[border-color,box-shadow] duration-150 focus-within:border-t-border-strong focus-within:shadow-[0_2px_8px_rgb(0_0_0/0.06)]",
          dragging &&
            "border-[var(--t-color-blue8)] ring-3 ring-[var(--t-color-blue4)]",
        )}
        onClick={(event) => {
          if (event.target === event.currentTarget) textarea.current?.focus();
        }}
      >
        {(picked || images.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2.5">
            {picked && (
              <Chip
                variant="soft"
                size="md"
                maxWidth={320}
                startElement={<IconClick size={14} />}
                endElement={
                  <button
                    type="button"
                    aria-label="Forget the picked element"
                    className="flex rounded-xs text-t-text-tertiary hover:text-t-text"
                    onClick={onClearPicked}
                  >
                    <IconX size={12} />
                  </button>
                }
              >
                <span className="font-mono text-[11px]">
                  &lt;{picked.tag}&gt; {picked.loc}
                </span>
              </Chip>
            )}
            {images.map((image) => (
              <div
                key={image.url}
                className="group relative size-12 overflow-hidden rounded-md border border-t-border"
              >
                <img
                  src={image.url}
                  alt={image.file.name}
                  className="size-full object-cover"
                />
                <button
                  type="button"
                  aria-label={`Remove ${image.file.name}`}
                  className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => removeImage(image.url)}
                >
                  <IconX size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <Textarea
          ref={textarea}
          aria-label="Message"
          variant="plain"
          autoResize
          maxRows={12}
          rows={2}
          placeholder={
            mode === "chat" ? "Ask a question or plan a change…" : placeholder
          }
          value={value}
          autoFocus={autoFocus}
          className="min-h-14 w-full resize-none bg-transparent px-3 pt-2.5 text-[16px] leading-[1.5] outline-none md:text-[13px]"
          onValueChange={(next) => setValue(next)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.some((file) => file.type.startsWith("image/"))) {
              event.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex items-center gap-1">
            <LightIconButton
              aria-label="Attach images"
              tooltip="Attach images"
              tooltipPlace="top"
              disabled={images.length >= MAX_IMAGES}
              onClick={() => fileInput.current?.click()}
            >
              <IconPhoto size={16} />
            </LightIconButton>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <SegmentedControl<Mode>
              aria-label="Mode"
              size="sm"
              value={mode}
              onValueChange={(next) => setMode(next)}
              options={[
                {
                  value: "build",
                  label: "Build",
                  startIcon: <IconTool size={14} />,
                  "aria-label": "Build: the agent changes the app",
                },
                {
                  value: "chat",
                  label: "Chat",
                  startIcon: <IconMessageCircle size={14} />,
                  "aria-label": "Chat: discuss without changing the app",
                },
              ]}
            />
          </div>
          <IconButton
            type="submit"
            aria-label="Send"
            variant="solid"
            color="accent"
            shape="round"
            size="sm"
            loading={sending}
            disabled={!canSend}
          >
            <IconArrowUp size={14} />
          </IconButton>
        </div>
      </div>
      {error && <p className="text-t-text-danger">{error}</p>}
    </form>
  );
}
