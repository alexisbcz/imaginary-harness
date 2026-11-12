// The ideas backlog: angles for future issues, with their notes, status and planned day. Each one becomes a draft
// in a click: written by you from its notes, or by the copilot.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button, Input, Textarea } from "twenty-ui/primitives/input";
import { Tag } from "twenty-ui/primitives/data-display";
import { IconBulb, IconFilePencil, IconPlus, IconSparkles, IconTrash } from "@tabler/icons-react";

import { Field, Modal } from "@/components/newsletter/editor";
import { SimpleSelect } from "@/components/simple-select";
import { intlLocale } from "@/lib/i18n";
import {
  createIdea,
  deleteIdea,
  draftFromIdea,
  IDEA_STATUSES,
  updateIdea,
  useIdeas,
  type Idea,
  type Newsletter,
} from "@/lib/newsletter";

const STATUS_COLORS: Record<Idea["status"], "gray" | "blue" | "amber" | "green" | "red"> = {
  idea: "gray",
  planned: "blue",
  drafting: "amber",
  done: "green",
  dropped: "red",
};

function IdeaDialog({
  newsletter,
  idea,
  onClose,
  onSaved,
}: {
  newsletter: Newsletter;
  idea: Idea | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(["newsletter", "common"]);
  const [title, setTitle] = useState(idea?.title ?? "");
  const [notes, setNotes] = useState(idea?.notes ?? "");
  const [status, setStatus] = useState<Idea["status"]>(idea?.status ?? "idea");
  const [planned, setPlanned] = useState(idea?.planned_for ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      title={idea ? t("ideas.dialog.title") : t("ideas.new")}
      onClose={onClose}
      wide
      footer={
        <>
          {error && <span className="mr-auto text-t-text-danger">{error}</span>}
          <Button size="sm" variant="ghost" onClick={onClose}>{t("common:cancel")}</Button>
          <Button size="sm" variant="solid" color="accent" loading={busy} disabled={!title.trim()} onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const input = { title: title.trim(), notes, status, planned_for: planned || null };
              if (idea) await updateIdea(newsletter.id, idea.id, input);
              else await createIdea(newsletter.id, input);
              onSaved();
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              setBusy(false);
            }
          }}>{t("common:save")}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("ideas.dialog.titleLabel")}>
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("ideas.dialog.titlePlaceholder")} />
        </Field>
        <Field label={t("ideas.dialog.notes")} hint={t("ideas.dialog.notesHint")}>
          <Textarea rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("ideas.dialog.status")}>
            <SimpleSelect<Idea["status"]>
              label={t("ideas.dialog.status")}
              value={status}
              onValueChange={setStatus}
              options={IDEA_STATUSES.map((s) => ({ value: s.value, label: t(`ideas.statuses.${s.value}`) }))}
            />
          </Field>
          <Field label={t("ideas.dialog.plannedFor")}>
            <Input type="date" value={planned} onChange={(e) => setPlanned(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

export function NewsletterIdeas({
  newsletter,
  onOpenPost,
  onAsk,
}: {
  newsletter: Newsletter;
  onOpenPost: (id: number) => void;
  onAsk: (message: string) => void;
}) {
  const { t } = useTranslation(["newsletter", "common"]);
  const { data: ideas, error, reload } = useIdeas(newsletter.id);
  const [editing, setEditing] = useState<Idea | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  async function run(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    setActionError(null);
    try {
      await action();
      void reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const open = (ideas ?? []).filter((i) => i.status !== "done" && i.status !== "dropped");
  const closed = (ideas ?? []).filter((i) => i.status === "done" || i.status === "dropped");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-5 px-5 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="solid" color="accent" startIcon={<IconPlus size={14} />} onClick={() => setEditing("new")}>
            {t("ideas.new")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            startIcon={<IconSparkles size={14} />}
            onClick={() =>
              onAsk(t("ideas.brainstormPrompt"))
            }
          >
            {t("ideas.brainstorm")}
          </Button>
        </div>
        {actionError && <p className="text-t-text-danger">{actionError}</p>}
        {error ? (
          <p className="text-t-text-danger">{error}</p>
        ) : !ideas ? (
          <div className="flex h-24 items-center justify-center"><Loader /></div>
        ) : open.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-t-border px-5 py-8 text-center text-t-text-secondary">
            <IconBulb size={20} className="text-t-text-light" />
            {t("ideas.empty")}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {open.map((idea) => (
              <li key={idea.id} className="flex flex-col gap-2 rounded-md border border-t-border px-3 py-2.5 sm:flex-row sm:items-start">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(idea)}>
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium text-t-text">{idea.title}</span>
                    <Tag variant="soft" color={STATUS_COLORS[idea.status]} className="shrink-0 text-[11px]">
                      {t(`ideas.statuses.${idea.status}`)}
                    </Tag>
                    {idea.source === "copilot" && <IconSparkles size={12} className="shrink-0 text-t-text-light" aria-label={t("ideas.fromCopilot")} />}
                  </span>
                  {idea.notes && <span className="mt-0.5 line-clamp-2 block text-[12px] leading-[1.5] text-t-text-tertiary">{idea.notes}</span>}
                  {idea.planned_for && (
                    <span className="mt-0.5 block text-[12px] text-t-text-secondary tabular-nums">
                      {t("ideas.plannedFor", {
                        date: new Date(`${idea.planned_for}T12:00:00`).toLocaleDateString(intlLocale(), { weekday: "short", day: "numeric", month: "short" }),
                      })}
                    </span>
                  )}
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  {idea.draft_id ? (
                    <Button size="sm" variant="outline" onClick={() => onOpenPost(Number(idea.draft_id))}>{t("ideas.openDraft")}</Button>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" startIcon={<IconFilePencil size={14} />} loading={busy === idea.id} onClick={() =>
                        run(idea.id, async () => onOpenPost((await draftFromIdea(newsletter.id, idea.id)).id))
                      }>
                        {t("ideas.writeMyself")}
                      </Button>
                      <Button size="sm" variant="ghost" startIcon={<IconSparkles size={14} />} onClick={() =>
                        onAsk(t("ideas.copilotWritesPrompt", { title: idea.title, id: idea.id }))
                      }>
                        {t("ideas.copilotWrites")}
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" aria-label={t("ideas.delete")} onClick={() => run(idea.id, () => deleteIdea(newsletter.id, idea.id))}>
                    <IconTrash size={14} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {closed.length > 0 && (
          <div className="flex flex-col gap-2">
            <button type="button" className="self-start text-[12px] text-t-text-tertiary hover:text-t-text" onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? t("ideas.hideClosed", { count: closed.length }) : t("ideas.showClosed", { count: closed.length })}
            </button>
            {showClosed && (
              <ul className="flex flex-col divide-y divide-t-border-light rounded-md border border-t-border">
                {closed.map((idea) => (
                  <li key={idea.id}>
                    <button type="button" onClick={() => setEditing(idea)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-t-text-secondary hover:bg-t-hover">
                      <span className="min-w-0 flex-1 truncate">{idea.title}</span>
                      <Tag variant="soft" color={STATUS_COLORS[idea.status]} className="text-[11px]">
                        {t(`ideas.statuses.${idea.status}`)}
                      </Tag>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {editing && <IdeaDialog newsletter={newsletter} idea={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
    </div>
  );
}
