import { useState } from "react";
import { IconArrow } from "@pierre/icons";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";

/** The message box: Enter sends, Shift+Enter adds a line. */
export function Composer({
  onSend,
  disabled = false,
  autoFocus = false,
}: {
  onSend: (content: string) => Promise<void>;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const content = value.trim();
  const canSend = content.length > 0 && !sending && !disabled;

  async function send() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await onSend(content);
      setValue("");
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
    >
      <InputGroup>
        <InputGroupTextarea
          aria-label="Message"
          placeholder="Ask Richelieu…"
          value={value}
          autoFocus={autoFocus}
          className="max-h-60 min-h-16 text-base md:text-sm"
          onChange={(event) => setValue(event.target.value)}
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
        <InputGroupAddon align="block-end" className="justify-end">
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
