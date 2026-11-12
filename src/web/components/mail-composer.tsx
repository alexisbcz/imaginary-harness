import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LightIconButton } from "twenty-ui/components/input";
import { Button, Input } from "twenty-ui/primitives/input";
import { Dialog } from "twenty-ui/primitives/surfaces";
import { IconPaperclip, IconX } from "twenty-ui/icon";
import { IconFile, IconFileTypePdf, IconFileZip, IconPhoto } from "@tabler/icons-react";
import { cn } from "cn";

import { imageDataUrl, textToHtml, toEmail } from "@/components/rich-editor/email";
import { RichEditor } from "@/components/rich-editor/rich-editor";
import { SimpleSelect } from "@/components/simple-select";
import i18n, { intlLocale } from "@/lib/i18n";
import { saveDraft, sendMail, type Draft, type MailAccount } from "@/lib/mail";

const MAX_TOTAL = 20 * 1024 * 1024;

const sizeOf = (bytes: number) =>
  bytes < 1024
    ? i18n.t("mail:size.b", { n: bytes.toLocaleString(intlLocale()) })
    : bytes < 1024 * 1024
      ? i18n.t("mail:size.kb", { n: Math.round(bytes / 1024).toLocaleString(intlLocale()) })
      : i18n.t("mail:size.mb", {
          n: (bytes / 1024 / 1024).toLocaleString(intlLocale(), {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }),
        });

function FileIcon({ type }: { type: string }) {
  if (type.startsWith("image/")) return <IconPhoto size={15} />;
  if (type === "application/pdf") return <IconFileTypePdf size={15} />;
  if (/zip|compressed|tar/.test(type)) return <IconFileZip size={15} />;
  return <IconFile size={15} />;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-h-10 items-center gap-2 border-b border-t-border-light px-4">
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
  const { t } = useTranslation("mail");
  const { t: tc } = useTranslation("common");
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
  const [dragging, setDragging] = useState(false);
  // A new editor for each message opened, with its first content.
  const [generation, setGeneration] = useState(0);
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
    setGeneration((g) => g + 1);
  }, [open]);

  const initialContent = useMemo(
    () => initial.html ?? textToHtml(initial.text ?? ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [generation],
  );

  /** The message as it goes out: styles inlined, pasted images as inline parts. */
  function outgoing(): Draft {
    const email = toEmail(draft.html ?? "", draft.text);
    const attachments = [...draft.attachments, ...email.inline];
    if (attachments.reduce((n, a) => n + a.size, 0) > MAX_TOTAL)
      throw new Error(t("composer.tooLarge"));
    return { ...draft, html: draft.html?.trim() ? email.html : undefined, text: email.text, attachments };
  }

  const set = (values: Partial<Draft>) =>
    setDraft((d) => ({ ...d, ...values }));

  async function send() {
    if (!draft.to.trim() && !draft.cc.trim() && !draft.bcc.trim())
      return setError(t("composer.noRecipient"));
    setSending(true);
    setError(null);
    try {
      const result = await sendMail({ ...outgoing(), key: key.current });
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
      const { id } = await saveDraft(outgoing());
      set({ draftId: id });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function attach(list: FileList | File[] | null) {
    if (!list || list.length === 0) return;
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
      return setError(t("composer.attachmentsTooLarge"));
    set({ attachments: [...draft.attachments, ...added] });
  }

  const from = accounts.find((a) => a.id === draft.from);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Viewport>
          <Dialog.Popup className="flex h-[min(820px,92svh)] w-[min(820px,calc(100vw-16px))] flex-col overflow-hidden p-0">
            <div className="flex h-11 shrink-0 items-center border-b border-t-border-light pr-2 pl-4">
              <Dialog.Title className="flex-1 text-[14px] font-semibold">
                {draft.replyTo
                  ? t("composer.reply")
                  : draft.subject.startsWith("Fwd:")
                    ? t("composer.forward")
                    : t("composer.newMessage")}
              </Dialog.Title>
              <Dialog.Close
                render={
                  <LightIconButton aria-label={tc("close")}>
                    <IconX size={16} />
                  </LightIconButton>
                }
              />
            </div>
            <form
              className="relative flex min-h-0 flex-1 flex-col"
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes("Files")) {
                  e.preventDefault();
                  setDragging(true);
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
              }}
              onDrop={(e) => {
                setDragging(false);
                // Images dropped on the text go into it (the editor takes them); anything else is attached.
                if (e.defaultPrevented) return;
                e.preventDefault();
                void attach([...e.dataTransfer.files]);
              }}
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
                <Row label={t("composer.from")}>
                  <SimpleSelect
                    label={t("composer.from")}
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
              <Row label={t("composer.to")}>
                <div className="flex items-center">
                  <Input
                    variant="plain"
                    autoFocus={!initial.to}
                    aria-label={t("composer.to")}
                    placeholder={t("composer.toPlaceholder")}
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
                      {t("composer.ccBcc")}
                    </button>
                  )}
                </div>
              </Row>
              {showCc && (
                <>
                  <Row label={t("composer.cc")}>
                    <Input
                      variant="plain"
                      aria-label={t("composer.cc")}
                      value={draft.cc}
                      onChange={(e) => set({ cc: e.target.value })}
                    />
                  </Row>
                  <Row label={t("composer.bcc")}>
                    <Input
                      variant="plain"
                      aria-label={t("composer.bcc")}
                      value={draft.bcc}
                      onChange={(e) => set({ bcc: e.target.value })}
                    />
                  </Row>
                </>
              )}
              <Row label={t("composer.subject")}>
                <Input
                  variant="plain"
                  aria-label={t("composer.subject")}
                  value={draft.subject}
                  onChange={(e) => set({ subject: e.target.value })}
                />
              </Row>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <RichEditor
                  key={generation}
                  variant="mail"
                  initialContent={initialContent}
                  autofocus={Boolean(initial.to)}
                  placeholder={from ? t("composer.writingAs", { address: from.address }) : t("composer.placeholder")}
                  onChange={(editor) => set({ html: editor.getHTML(), text: editor.getText({ blockSeparator: "\n\n" }) })}
                  uploadImage={(file) => imageDataUrl(file)}
                  onFiles={(files) => void attach(files)}
                  className="min-h-full"
                  contentClassName="px-5 pt-4 pb-16 min-h-[240px]"
                />
              </div>
              {dragging && (
                <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-[var(--t-color-blue9)] bg-[color-mix(in_oklab,var(--t-color-blue9)_8%,var(--t-background-primary))] text-[14px] font-medium text-[var(--t-color-blue10)]">
                  {t("composer.drop")}
                </div>
              )}
              {draft.attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 border-t border-t-border-light px-4 py-2.5">
                  {draft.attachments.map((a, i) => (
                    <span
                      key={`${a.filename}-${i}`}
                      className="group flex max-w-[240px] items-center gap-2 rounded-lg border border-t-border bg-t-secondary py-1.5 pr-1 pl-2.5"
                    >
                      {a.contentType.startsWith("image/") ? (
                        <img src={`data:${a.contentType};base64,${a.data}`} alt="" className="size-7 shrink-0 rounded object-cover" />
                      ) : (
                        <span className="flex size-7 shrink-0 items-center justify-center rounded bg-t-primary text-t-text-secondary">
                          <FileIcon type={a.contentType} />
                        </span>
                      )}
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block truncate text-[12px] font-medium text-t-text">{a.filename}</span>
                        <span className="block text-[11px] text-t-text-tertiary">{sizeOf(a.size)}</span>
                      </span>
                      <LightIconButton
                        size="xs"
                        aria-label={t("composer.remove", { filename: a.filename })}
                        onClick={() =>
                          set({
                            attachments: draft.attachments.filter((_, j) => j !== i),
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
                  {t("composer.send")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  loading={saving}
                  onClick={() => void save()}
                >
                  {t("composer.saveDraft")}
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
                  aria-label={t("composer.attach")}
                  tooltip={t("composer.attach")}
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
