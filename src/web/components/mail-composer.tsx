import { useEffect, useRef, useState } from "react";
import { LightIconButton } from "twenty-ui/components/input";
import { Button, Input, Textarea } from "twenty-ui/primitives/input";
import { Dialog } from "twenty-ui/primitives/surfaces";
import { IconPaperclip, IconX } from "twenty-ui/icon";

import { SimpleSelect } from "@/components/simple-select";
import { saveDraft, sendMail, type Draft, type MailAccount } from "@/lib/mail";

const MAX_TOTAL = 20 * 1024 * 1024;

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 border-b border-t-border-light px-4">
      <span className="w-12 shrink-0 text-[12px] text-t-text-tertiary">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </label>
  );
}

const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Writing a message: a new one, a reply or a forward, prefilled by `initial`. ⌘↵ sends. */
export function MailComposer({
  open,
  onOpenChange,
  accounts,
  initial,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: MailAccount[];
  initial: Partial<Draft>;
  onSent: (result: { queued: string[]; local: string[] }) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => ({
    from: accounts[0]?.id ?? "",
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    text: "",
    attachments: [],
  }));
  const [showCc, setShowCc] = useState(false);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per message being written: a retried or double-clicked send goes out once.
  const key = useRef(crypto.randomUUID());
  const files = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    key.current = crypto.randomUUID();
    setError(null);
    setDraft({
      from: accounts[0]?.id ?? "",
      to: "",
      cc: "",
      bcc: "",
      subject: "",
      text: "",
      attachments: [],
      ...initial,
    });
    setShowCc(Boolean(initial.cc || initial.bcc));
  }, [open]);

  const set = (values: Partial<Draft>) =>
    setDraft((d) => ({ ...d, ...values }));

  async function send() {
    if (!draft.to.trim() && !draft.cc.trim() && !draft.bcc.trim())
      return setError("Add a recipient");
    setSending(true);
    setError(null);
    try {
      const result = await sendMail({ ...draft, key: key.current });
      onSent(result);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const { id } = await saveDraft(draft);
      set({ draftId: id });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function attach(list: FileList | null) {
    if (!list) return;
    const added = await Promise.all(
      [...list].map(async (file) => ({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        data: await toBase64(file),
        size: file.size,
      })),
    );
    const total = [...draft.attachments, ...added].reduce(
      (n, a) => n + a.size,
      0,
    );
    if (total > MAX_TOTAL)
      return setError("Attachments are limited to 20 MB in all");
    set({ attachments: [...draft.attachments, ...added] });
  }

  const from = accounts.find((a) => a.id === draft.from);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Viewport>
          <Dialog.Popup className="flex max-h-[min(720px,92svh)] w-[min(680px,calc(100vw-16px))] flex-col overflow-hidden p-0">
            <div className="flex h-11 shrink-0 items-center border-b border-t-border-light pr-2 pl-4">
              <Dialog.Title className="flex-1 text-[14px] font-semibold">
                {draft.replyTo
                  ? "Reply"
                  : draft.subject.startsWith("Fwd:")
                    ? "Forward"
                    : "New message"}
              </Dialog.Title>
              <Dialog.Close
                render={
                  <LightIconButton aria-label="Close">
                    <IconX size={16} />
                  </LightIconButton>
                }
              />
            </div>
            <form
              className="flex min-h-0 flex-1 flex-col"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            >
              {accounts.length > 1 && (
                <Row label="From">
                  <SimpleSelect
                    label="From"
                    bare
                    value={draft.from}
                    onValueChange={(value) => set({ from: value })}
                    options={accounts.map((a) => ({
                      value: a.id,
                      label: a.display_name
                        ? `${a.display_name} <${a.address}>`
                        : a.address,
                    }))}
                  />
                </Row>
              )}
              <Row label="To">
                <div className="flex items-center">
                  <Input
                    variant="plain"
                    autoFocus={!initial.to}
                    aria-label="To"
                    placeholder="name@example.com, …"
                    value={draft.to}
                    onChange={(e) => set({ to: e.target.value })}
                    className="flex-1"
                  />
                  {!showCc && (
                    <button
                      type="button"
                      className="shrink-0 px-1 text-[12px] text-t-text-tertiary hover:text-t-text"
                      onClick={() => setShowCc(true)}
                    >
                      Cc Bcc
                    </button>
                  )}
                </div>
              </Row>
              {showCc && (
                <>
                  <Row label="Cc">
                    <Input
                      variant="plain"
                      aria-label="Cc"
                      value={draft.cc}
                      onChange={(e) => set({ cc: e.target.value })}
                    />
                  </Row>
                  <Row label="Bcc">
                    <Input
                      variant="plain"
                      aria-label="Bcc"
                      value={draft.bcc}
                      onChange={(e) => set({ bcc: e.target.value })}
                    />
                  </Row>
                </>
              )}
              <Row label="Subject">
                <Input
                  variant="plain"
                  aria-label="Subject"
                  value={draft.subject}
                  onChange={(e) => set({ subject: e.target.value })}
                />
              </Row>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                <Textarea
                  variant="plain"
                  aria-label="Message"
                  autoFocus={Boolean(initial.to)}
                  rows={12}
                  autoResize
                  maxRows={30}
                  value={draft.text}
                  onChange={(e) => set({ text: e.target.value })}
                  placeholder={from ? `Writing as ${from.address}` : ""}
                  className="text-[14px] leading-[1.6]"
                />
              </div>
              {draft.attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-4 pb-2">
                  {draft.attachments.map((a, i) => (
                    <span
                      key={`${a.filename}-${i}`}
                      className="flex items-center gap-1 rounded-sm bg-t-tertiary py-0.5 pr-0.5 pl-2 text-[12px]"
                    >
                      {a.filename}
                      <LightIconButton
                        size="xs"
                        aria-label={`Remove ${a.filename}`}
                        onClick={() =>
                          set({
                            attachments: draft.attachments.filter(
                              (_, j) => j !== i,
                            ),
                          })
                        }
                      >
                        <IconX size={12} />
                      </LightIconButton>
                    </span>
                  ))}
                </div>
              )}
              {error && (
                <p className="px-4 pb-2 text-[12px] text-[var(--t-color-red11)]">
                  {error}
                </p>
              )}
              <div className="flex shrink-0 items-center gap-2 border-t border-t-border-light px-3 py-2">
                <Button
                  type="submit"
                  size="sm"
                  variant="solid"
                  color="accent"
                  loading={sending}
                  shortcut={["⌘", "↵"]}
                >
                  Send
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  loading={saving}
                  onClick={() => void save()}
                >
                  Save draft
                </Button>
                <div className="flex-1" />
                <input
                  ref={files}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) =>
                    void attach(e.target.files).finally(
                      () => (e.target.value = ""),
                    )
                  }
                />
                <LightIconButton
                  aria-label="Attach files"
                  tooltip="Attach files"
                  onClick={() => files.current?.click()}
                >
                  <IconPaperclip size={16} />
                </LightIconButton>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
