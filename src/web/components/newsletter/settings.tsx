// A newsletter's settings: its Substack connection (a session cookie, kept sealed on the server), its brief (what
// the copilot and the AI assists write from), and deleting it from Richelieu.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Input, Textarea } from "twenty-ui/primitives/input";
import { IconAlertTriangle, IconCircleCheck, IconExternalLink, IconSparkles } from "@tabler/icons-react";

import { Field } from "@/components/newsletter/editor";
import { SimpleSelect } from "@/components/simple-select";
import {
  AUDIENCES,
  connectNewsletter,
  deleteNewsletter,
  disconnectNewsletter,
  updateNewsletter,
  type Audience,
  type Newsletter,
  type NewsletterStatus,
} from "@/lib/newsletter";

function Section({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-t-text">{title}</h2>
          {description && <p className="mt-0.5 leading-[1.5] text-t-text-tertiary">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** How to find the session cookie: Substack has no API keys. */
export function CookieHelp() {
  return (
    <details className="rounded-md border border-t-border bg-t-secondary px-3 py-2 text-[12px] leading-[1.6] text-t-text-secondary">
      <summary className="cursor-pointer font-medium text-t-text">Where do I find it?</summary>
      <ol className="mt-1 list-decimal pl-5">
        <li>Sign in to substack.com in your browser.</li>
        <li>Open the developer tools (⌥⌘I or F12) → Application (Storage in Firefox) → Cookies → https://substack.com.</li>
        <li>Copy the value of <code>substack.sid</code> and paste it here.</li>
      </ol>
      <p className="mt-1">
        Substack has no public API, so Richelieu acts as you with this session. It is stored encrypted, only the server
        reads it, and it stops working when you sign out of Substack.
      </p>
    </details>
  );
}

export function ConnectForm({ newsletter, onConnected }: { newsletter: Newsletter; onConnected?: () => void }) {
  const [publication, setPublication] = useState(newsletter.publication_url ?? "");
  const [cookie, setCookie] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await connectNewsletter(newsletter.id, { publication: publication.trim() || undefined, cookie });
          setCookie("");
          onConnected?.();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Publication" hint="name.substack.com or your custom domain. Leave empty for your first publication.">
        <Input value={publication} placeholder="yourname.substack.com" onChange={(e) => setPublication(e.target.value)} />
      </Field>
      <Field label="Substack session (substack.sid cookie)">
        <Input type="password" autoComplete="off" value={cookie} placeholder="s%3A…" onChange={(e) => setCookie(e.target.value)} />
      </Field>
      <CookieHelp />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="solid" color="accent" loading={busy} disabled={!cookie.trim()}>
          {newsletter.connected_at ? "Reconnect" : "Connect to Substack"}
        </Button>
        {error && <span className="text-t-text-danger">{error}</span>}
      </div>
    </form>
  );
}

type Draft = {
  name: string;
  description: string;
  audience: string;
  voice: string;
  pillars: string;
  format: string;
  avoid: string;
  examples: string;
  timezone: string;
  cadence: string;
  default_audience: Audience;
};

const draftOf = (n: Newsletter): Draft => ({
  name: n.name,
  description: n.description,
  audience: n.audience,
  voice: n.voice,
  pillars: n.pillars.join("\n"),
  format: n.format,
  avoid: n.avoid,
  examples: n.examples,
  timezone: n.timezone,
  cadence: String(n.cadence),
  default_audience: n.default_audience,
});

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return [];
  }
})();

export function NewsletterSettings({
  newsletter,
  status,
  onAsk,
  onDeleted,
}: {
  newsletter: Newsletter;
  status: NewsletterStatus;
  onAsk: (message: string) => void;
  onDeleted: () => void;
}) {
  const initial = useMemo(() => draftOf(newsletter), [newsletter]);
  const [draft, setDraft] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "delete" | "disconnect">(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  // The copilot updates the brief too: follow it unless the user is editing.
  useEffect(() => {
    if (!touched) setDraft(initial);
  }, [initial, touched]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setTouched(true);
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateNewsletter(newsletter.id, {
        ...draft,
        pillars: draft.pillars.split(/\n|;/).map((p) => p.trim()).filter(Boolean),
        cadence: Number(draft.cadence) || 0,
      });
      setTouched(false);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-10 px-5 py-6">
        <Section
          title="Substack"
          description="Richelieu writes drafts, publishes and reads your stats through your Substack session."
        >
          {newsletter.connected_at ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3 rounded-md border border-t-border px-3 py-2.5">
                {newsletter.logo_url ? (
                  <img src={newsletter.logo_url} alt="" className="size-8 rounded" />
                ) : (
                  <IconCircleCheck size={20} className="text-[var(--t-color-green9)]" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-t-text">{newsletter.publication_url?.replace(/^https:\/\//, "")}</div>
                  <div className="truncate text-[12px] text-t-text-tertiary">
                    As {newsletter.substack_user_name ?? "you"}
                    {newsletter.paid ? " · paid subscriptions on" : ""}
                  </div>
                </div>
                <a href={`${newsletter.publication_url}/publish/home`} target="_blank" rel="noreferrer" className="rounded p-1 text-t-text-tertiary hover:bg-t-hover hover:text-t-text" aria-label="Open the Substack dashboard">
                  <IconExternalLink size={15} />
                </a>
                {confirm === "disconnect" ? (
                  <span className="flex items-center gap-1.5">
                    <Button size="sm" variant="solid" color="danger" loading={busy} onClick={async () => {
                      setBusy(true);
                      try {
                        await disconnectNewsletter(newsletter.id);
                      } finally {
                        setBusy(false);
                        setConfirm(null);
                      }
                    }}>Disconnect</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Keep</Button>
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirm("disconnect")}>Disconnect</Button>
                )}
              </div>
              {newsletter.connection_error && (
                <div className="flex items-start gap-2 rounded-md border border-t-border bg-t-secondary px-3 py-2 text-t-text">
                  <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--t-color-orange9)]" />
                  <span>{newsletter.connection_error}. Paste a fresh cookie below.</span>
                </div>
              )}
              <details>
                <summary className="cursor-pointer text-[12px] text-t-text-secondary">Change the publication or the session</summary>
                <div className="mt-3">
                  <ConnectForm newsletter={newsletter} />
                </div>
              </details>
              <p className="text-[12px] text-t-text-light">
                Substack MCP: {status.mcp ? "on, the copilot also reaches substack-mcp's tools (subscribers, detailed analytics, the reader feed)." : "off. Set SUBSTACK_MCP=true on the server to give the copilot substack-mcp's tools too."}
              </p>
            </div>
          ) : (
            <ConnectForm newsletter={newsletter} />
          )}
        </Section>

        <Section
          title="Brief"
          description="What every draft is written from. The copilot fills it from your past posts and keeps it up to date."
          actions={
            <Button size="sm" variant="outline" startIcon={<IconSparkles size={14} />} onClick={() =>
              onAsk(
                newsletter.connected_at
                  ? "Read my last published posts and how they performed, then write our brief: what the newsletter is about, who reads it, my voice, recurring themes, the format of an issue, what to avoid, and two short passages that sound like me. Tell me what you changed."
                  : "Interview me to write our newsletter's brief (what it is about, readers, voice, themes, format), then save it.",
              )
            }>
              Fill with the copilot
            </Button>
          }
        >
          <form className="flex flex-col gap-4" onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <Field label="Issues a week" hint="The copilot plans towards it. 0.5 is every other week.">
                <Input type="number" min={0} max={14} step={0.5} value={draft.cadence} onChange={(e) => set("cadence", e.target.value)} />
              </Field>
            </div>
            <Field label="What it is about" hint="The subject, the promise to readers, what makes it different.">
              <Textarea rows={3} value={draft.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
            <Field label="Readers" hint="Who they are, what they already know, why they subscribe.">
              <Textarea rows={2} value={draft.audience} onChange={(e) => set("audience", e.target.value)} />
            </Field>
            <Field label="Voice" hint="e.g. “first person, candid, dry humour, short paragraphs, no jargon”.">
              <Textarea rows={2} value={draft.voice} onChange={(e) => set("voice", e.target.value)} />
            </Field>
            <Field label="Recurring themes" hint="One per line.">
              <Textarea rows={4} value={draft.pillars} onChange={(e) => set("pillars", e.target.value)} />
            </Field>
            <Field label="Format of an issue" hint="Sections, recurring segments, typical length, how it ends.">
              <Textarea rows={3} value={draft.format} onChange={(e) => set("format", e.target.value)} />
            </Field>
            <Field label="Never" hint="Topics, words or habits to avoid.">
              <Textarea rows={2} value={draft.avoid} onChange={(e) => set("avoid", e.target.value)} />
            </Field>
            <Field label="Passages that sound like you" hint="Two or three short excerpts.">
              <Textarea rows={5} value={draft.examples} onChange={(e) => set("examples", e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Time zone" hint="Scheduling and dates use it.">
                <Input list="newsletter-zones" value={draft.timezone} onChange={(e) => set("timezone", e.target.value)} />
                <datalist id="newsletter-zones">
                  {ZONES.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </Field>
              <Field label="New drafts are for">
                <SimpleSelect<Audience> label="Default audience" value={draft.default_audience} onValueChange={(v) => set("default_audience", v)} options={AUDIENCES} />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" variant="solid" color="accent" size="sm" loading={saving} disabled={!dirty}>
                Save the brief
              </Button>
              {saved && !dirty && <span className="text-[12px] text-t-text-tertiary">Saved</span>}
              {error && <span className="text-t-text-danger">{error}</span>}
            </div>
          </form>
        </Section>

        <Section title="Remove from Richelieu" description="Removes its brief, ideas, notes and copilot conversation. Your posts and subscribers stay on Substack.">
          <div className="flex items-center gap-2">
            {confirm === "delete" ? (
              <>
                <Button size="sm" variant="solid" color="danger" loading={busy} onClick={async () => {
                  setBusy(true);
                  try {
                    await deleteNewsletter(newsletter.id);
                    onDeleted();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                    setBusy(false);
                  }
                }}>
                  Remove {newsletter.name}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
              </>
            ) : (
              <Button size="sm" variant="outline" color="danger" onClick={() => setConfirm("delete")}>
                Remove the newsletter…
              </Button>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}
