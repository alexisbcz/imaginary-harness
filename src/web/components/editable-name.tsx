import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { useTranslation } from "react-i18next";

/**
 * A name that is renamed in place: it reads as text, a click turns it into a field, Enter or leaving the field
 * saves it, Escape gives up. An empty name is not saved.
 */
export function EditableName({
  value,
  onRename,
  label,
  maxLength = 80,
  className,
  inputClassName,
}: {
  value: string;
  onRename: (name: string) => Promise<void> | void;
  /** What the field is, in full: "Rename the project". */
  label: string;
  maxLength?: number;
  className?: string;
  inputClassName?: string;
}) {
  const { t } = useTranslation("common");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  function commit() {
    setEditing(false);
    const next = draft.replace(/\s+/g, " ").trim();
    if (next && next !== value) void onRename(next);
    else setDraft(value);
  }

  if (editing)
    return (
      <input
        ref={input}
        aria-label={label}
        value={draft}
        maxLength={maxLength}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        className={cn(
          "min-w-0 rounded-sm bg-transparent text-t-text outline-none px-1 -mx-1 ring-2 ring-ring",
          inputClassName,
        )}
      />
    );

  return (
    <button
      type="button"
      title={t("rename")}
      aria-label={`${label}: ${value}`}
      onClick={() => setEditing(true)}
      className={cn(
        "-mx-1 min-w-0 cursor-text truncate rounded-sm px-1 text-left outline-none hover:bg-t-hover focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {value}
    </button>
  );
}
