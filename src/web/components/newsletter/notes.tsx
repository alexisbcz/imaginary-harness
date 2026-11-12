// Substack Notes: short posts on Substack's feed, drafted here by you or the copilot, published now or at a time.

import { useState } from "react";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button, Input, Textarea } from "twenty-ui/primitives/input";
import { Tag } from "twenty-ui/primitives/data-display";
import { IconClock, IconExternalLink, IconNotes, IconSend, IconSparkles, IconTrash } from "@tabler/icons-react";

import { Field, Modal } from "@/components/newsletter/editor";
import { PostPreview } from "@/components/newsletter/preview";
import {
  deleteNote,
  formatMoment,
  fromLocalInput,
  markdownToDoc,
  publishNote,
  saveNote,
  scheduleNote,
  toLocalInput,
  useNotes,
  type Newsletter,
  type Note,
} from "@/lib/newsletter";

function NoteCard({ newsletter, note, onChanged }: { newsletter: Newsletter; note: Note; onChanged: () => void }) {
  const [body, setBody] = useState(note.body);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "publish" | "schedule">(null);
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 3_600_000), newsletter.timezone));
  const editable = note.status === "draft" || note.status === "failed" || note.status === "scheduled";
  const dirty = body !== note.body;

  async function run(name: string, action: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await action();
      setDialog(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-t-border p-3">
      <div className="flex items-center gap-2 text-[12px] text-t-text-tertiary">
        {note.source === "copilot" && <IconSparkles size={12} aria-label="Drafted by the copilot" />}
        <span className="flex-1">
          {note.status === "published"
            ? `Published ${formatMoment(note.published_at, newsletter.timezone)}`
            : note.status === "scheduled"
              ? `Goes out ${formatMoment(note.publish_at, newsletter.timezone)}`
              : note.status === "publishing"
                ? "Publishing…"
                : `Draft · ${formatMoment(note.created_at, newsletter.timezone)}`}
        </span>
        {note.status === "failed" && <Tag variant="soft" color="red" className="text-[11px]">Failed</Tag>}
        {note.url && (
          <a href={note.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-t-text">
            Open <IconExternalLink size={12} />
          </a>
        )}
      </div>
      {editable ? (
        <Textarea rows={Math.min(10, Math.max(3, body.split("\n").length + 1))} value={body} onChange={(e) => setBody(e.target.value)} />
      ) : (
        <p className="leading-[1.55] whitespace-pre-wrap text-t-text">{note.body}</p>
      )}
      {note.error && <p className="text-[12px] text-t-text-danger">{note.error}</p>}
      {error && <p className="text-[12px] text-t-text-danger">{error}</p>}
      {editable && (
        <div className="flex flex-wrap items-center gap-1.5">
          {dirty && (
            <Button size="sm" variant="outline" loading={busy === "save"} onClick={() => run("save", () => saveNote(newsletter.id, body, note.id))}>
              Save
            </Button>
          )}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" aria-label="Delete the note" loading={busy === "delete"} onClick={() => run("delete", () => deleteNote(newsletter.id, note.id))}>
            <IconTrash size={14} />
          </Button>
          {note.status === "scheduled" ? (
            <Button size="sm" variant="ghost" loading={busy === "unschedule"} onClick={() => run("unschedule", () => scheduleNote(newsletter.id, note.id, null))}>
              Unschedule
            </Button>
          ) : (
            <Button size="sm" variant="ghost" startIcon={<IconClock size={14} />} disabled={!newsletter.connected_at} onClick={() => setDialog("schedule")}>
              Schedule
            </Button>
          )}
          <Button size="sm" variant="solid" color="accent" startIcon={<IconSend size={14} />} disabled={!newsletter.connected_at} onClick={() => setDialog("publish")}>
            Publish
          </Button>
        </div>
      )}
      {dialog === "publish" && (
        <Modal
          title="Publish this note?"
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button size="sm" variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
              <Button size="sm" variant="solid" color="accent" loading={busy === "publish"} onClick={() =>
                run("publish", async () => {
                  if (dirty) await saveNote(newsletter.id, body, note.id);
                  await publishNote(newsletter.id, note.id);
                })
              }>Publish on Substack</Button>
            </>
          }
        >
          <p className="mb-3 text-t-text-secondary">It goes on Substack's feed as {newsletter.substack_user_name ?? "you"}, right away.</p>
          <div className="rounded-md border border-t-border">
            <PostPreview doc={markdownToDoc(body)} title="" subtitle="" />
          </div>
        </Modal>
      )}
      {dialog === "schedule" && (
        <Modal
          title="Schedule this note"
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button size="sm" variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
              <Button size="sm" variant="solid" color="accent" loading={busy === "schedule"} onClick={() =>
                run("schedule", async () => {
                  const at = fromLocalInput(when, newsletter.timezone);
                  if (!at) throw new Error("Pick a time");
                  if (dirty) await saveNote(newsletter.id, body, note.id);
                  await scheduleNote(newsletter.id, note.id, at);
                })
              }>Schedule</Button>
            </>
          }
        >
          <Field label={`When (${newsletter.timezone})`}>
            <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
        </Modal>
      )}
    </li>
  );
}

export function NewsletterNotes({ newsletter, onAsk }: { newsletter: Newsletter; onAsk: (message: string) => void }) {
  const { data: notes, error, reload } = useNotes(newsletter.id);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-5 px-5 py-6">
        <form
          className="flex flex-col gap-2 rounded-md border border-t-border p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            setBusy(true);
            setSaveError(null);
            try {
              await saveNote(newsletter.id, draft);
              setDraft("");
              void reload();
            } catch (err) {
              setSaveError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Textarea rows={3} placeholder="A thought, a question for your readers, a line from your latest post…" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              startIcon={<IconSparkles size={14} />}
              onClick={() => onAsk("Draft five Substack Notes for this week: ideas from our latest posts, a question for readers, and one that teases the next issue.")}
            >
              Draft notes with the copilot
            </Button>
            {saveError && <span className="text-t-text-danger">{saveError}</span>}
            <span className="flex-1" />
            <Button size="sm" type="submit" variant="solid" color="accent" loading={busy} disabled={!draft.trim()}>
              Save draft
            </Button>
          </div>
        </form>
        {error ? (
          <p className="text-t-text-danger">{error}</p>
        ) : !notes ? (
          <div className="flex h-24 items-center justify-center"><Loader /></div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center text-t-text-secondary">
            <IconNotes size={20} className="text-t-text-light" />
            Notes bring readers to your posts. Draft one above.
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {notes.map((note) => (
              // Remount when the note changes elsewhere, so its text follows.
              <NoteCard key={`${note.id}:${note.status}:${note.body.length}`} newsletter={newsletter} note={note} onChanged={() => void reload()} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
