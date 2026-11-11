import { useEffect, useRef, useState } from "react";
import {
  IconArrow,
  IconCodeComments,
  IconCursor,
  IconImage,
  IconWrench,
  IconX,
} from "@pierre/icons";

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentGroup,
  AttachmentMedia,
} from "@/components/ui/attachment";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
      <InputGroup className={dragging ? "ring-[3px] ring-ring/50" : undefined}>
        {(picked || images.length > 0) && (
          <InputGroupAddon align="block-start" className="flex-wrap gap-2">
            {picked && (
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-xs">
                <IconCursor className="size-3.5 shrink-0" />
                <span className="truncate font-mono">
                  &lt;{picked.tag}&gt; {picked.loc}
                </span>
                <button
                  type="button"
                  aria-label="Forget the picked element"
                  className="-mr-0.5 rounded p-0.5 hover:bg-background"
                  onClick={onClearPicked}
                >
                  <IconX className="size-3" />
                </button>
              </span>
            )}
            {images.length > 0 && (
              <AttachmentGroup>
                {images.map((image) => (
                  <Attachment key={image.url} size="xs">
                    <AttachmentMedia variant="image">
                      <img src={image.url} alt={image.file.name} />
                    </AttachmentMedia>
                    <AttachmentActions>
                      <AttachmentAction
                        aria-label={`Remove ${image.file.name}`}
                        onClick={() => removeImage(image.url)}
                      >
                        <IconX />
                      </AttachmentAction>
                    </AttachmentActions>
                  </Attachment>
                ))}
              </AttachmentGroup>
            )}
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          ref={textarea}
          aria-label="Message"
          placeholder={
            mode === "chat" ? "Ask a question or plan a change…" : placeholder
          }
          value={value}
          autoFocus={autoFocus}
          className="max-h-60 min-h-16 text-base md:text-sm"
          onChange={(event) => setValue(event.target.value)}
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
        <InputGroupAddon align="block-end" className="justify-between">
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <InputGroupButton
                    size="icon-sm"
                    aria-label="Attach images"
                    disabled={images.length >= MAX_IMAGES}
                    onClick={() => fileInput.current?.click()}
                  />
                }
              >
                <IconImage />
              </TooltipTrigger>
              <TooltipContent>Attach images</TooltipContent>
            </Tooltip>
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
            <ToggleGroup
              size="sm"
              value={[mode]}
              onValueChange={(next: unknown[]) => {
                if (next[0] === "build" || next[0] === "chat") setMode(next[0]);
              }}
            >
              <ToggleGroupItem
                value="build"
                aria-label="Build: the agent changes the app"
              >
                <IconWrench />
                Build
              </ToggleGroupItem>
              <ToggleGroupItem
                value="chat"
                aria-label="Chat: discuss without changing the app"
              >
                <IconCodeComments />
                Chat
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <InputGroupButton
            type="submit"
            variant="default"
            size="icon-sm"
            disabled={!canSend}
            aria-label="Send"
          >
            {sending ? <Spinner /> : <IconArrow className="rotate-90" />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
