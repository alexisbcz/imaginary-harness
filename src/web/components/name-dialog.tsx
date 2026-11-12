import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Textarea } from "twenty-ui/primitives/input";
import { Dialog } from "twenty-ui/primitives/surfaces";

/**
 * Asks for a name, and a description when `describe` is set: creating a project, renaming a project or a chat.
 * Closes once `onSubmit` resolves; stays open with the error when it throws.
 */
export function NameDialog({
  open,
  onOpenChange,
  title,
  nameLabel,
  namePlaceholder,
  initialName = "",
  describe = false,
  descriptionLabel,
  descriptionPlaceholder,
  confirm,
  maxLength = 80,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  nameLabel: string;
  namePlaceholder?: string;
  initialName?: string;
  describe?: boolean;
  descriptionLabel?: string;
  descriptionPlaceholder?: string;
  confirm: string;
  maxLength?: number;
  onSubmit: (fields: { name: string; description: string }) => Promise<void>;
}) {
  const { t } = useTranslation("common");
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each opening starts from the current name.
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setDescription("");
    setError(null);
    setSaving(false);
  }, [open, initialName]);

  const trimmed = name.replace(/\s+/g, " ").trim();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ name: trimmed, description: description.trim() });
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Viewport>
          <Dialog.Popup size="sm">
            <form onSubmit={(event) => void submit(event)}>
              <Dialog.Header>
                <Dialog.Title>{title}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-t-text-secondary">{nameLabel}</span>
                  <Input
                    autoFocus
                    value={name}
                    maxLength={maxLength}
                    placeholder={namePlaceholder}
                    onChange={(event) => setName(event.target.value)}
                    onFocus={(event) => event.target.select()}
                  />
                </label>
                {describe && (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[12px] font-medium text-t-text-secondary">{descriptionLabel}</span>
                    <Textarea
                      rows={3}
                      value={description}
                      placeholder={descriptionPlaceholder}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </label>
                )}
                {error && <p className="text-t-text-danger">{error}</p>}
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.Close render={<Button type="button" variant="outline" />}>
                  {t("cancel")}
                </Dialog.Close>
                <Button
                  type="submit"
                  variant="solid"
                  color="accent"
                  loading={saving}
                  disabled={!trimmed}
                >
                  {confirm}
                </Button>
              </Dialog.Footer>
            </form>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
