// A newsletter's settings: its Substack connection (a session cookie, kept sealed on the server), its brief (what
// the copilot and the AI assists write from), and deleting it from Richelieu.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation(["newsletter", "common"]);
  return (
    <details className="rounded-md border border-t-border bg-t-secondary px-3 py-2 text-[12px] leading-[1.6] text-t-text-secondary">
      <summary className="cursor-pointer font-medium text-t-text">{t("settings.cookieHelp.title")}</summary>
      <ol className="mt-1 list-decimal pl-5">
        <li>{t("settings.cookieHelp.signIn")}</li>
        <li>{t("settings.cookieHelp.devTools")}</li>
        <li>
          <Trans t={t} i18nKey="settings.cookieHelp.copy" components={{ code: <code /> }} />
        </li>
      </ol>
      <p className="mt-1">{t("settings.cookieHelp.why")}</p>
    </details>
  );
}

export function ConnectForm({ newsletter, onConnected }: { newsletter: Newsletter; onConnected?: () => void }) {
  const { t } = useTranslation(["newsletter", "common"]);
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
      <Field label={t("settings.connect.publication")} hint={t("settings.connect.publicationHint")}>
        <Input value={publication} placeholder={t("settings.connect.publicationPlaceholder")} onChange={(e) => setPublication(e.target.value)} />
      </Field>
      <Field label={t("settings.connect.session")}>
        {/* i18n-ignore: the shape of a cookie value, not text */}
        <Input type="password" autoComplete="off" value={cookie} placeholder="s%3A…" onChange={(e) => setCookie(e.target.value)} />
      </Field>
      <CookieHelp />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="solid" color="accent" loading={busy} disabled={!cookie.trim()}>
          {newsletter.connected_at ? t("settings.connect.reconnect") : t("settings.connect.connect")}
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
  const { t } = useTranslation(["newsletter", "common"]);
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
          description={t("settings.substack.description")}
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
                    {newsletter.substack_user_name
                      ? t("settings.substack.as", { name: newsletter.substack_user_name })
                      : t("settings.substack.asYou")}
                    {newsletter.paid ? ` · ${t("settings.substack.paidOn")}` : ""}
                  </div>
                </div>
                <a href={`${newsletter.publication_url}/publish/home`} target="_blank" rel="noreferrer" className="rounded p-1 text-t-text-tertiary hover:bg-t-hover hover:text-t-text" aria-label={t("settings.substack.dashboard")}>
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
                    }}>{t("settings.substack.disconnect")}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>{t("settings.substack.keep")}</Button>
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirm("disconnect")}>{t("settings.substack.disconnect")}</Button>
                )}
              </div>
              {newsletter.connection_error && (
                <div className="flex items-start gap-2 rounded-md border border-t-border bg-t-secondary px-3 py-2 text-t-text">
                  <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--t-color-orange9)]" />
                  <span>{t("settings.substack.connectionError", { error: newsletter.connection_error })}</span>
                </div>
              )}
              <details>
                <summary className="cursor-pointer text-[12px] text-t-text-secondary">{t("settings.substack.change")}</summary>
                <div className="mt-3">
                  <ConnectForm newsletter={newsletter} />
                </div>
              </details>
              <p className="text-[12px] text-t-text-light">
                {status.mcp ? t("settings.substack.mcpOn") : t("settings.substack.mcpOff")}
              </p>
            </div>
          ) : (
            <ConnectForm newsletter={newsletter} />
          )}
        </Section>

        <Section
          title={t("settings.brief.title")}
          description={t("settings.brief.description")}
          actions={
            <Button size="sm" variant="outline" startIcon={<IconSparkles size={14} />} onClick={() =>
              onAsk(
                newsletter.connected_at ? t("settings.brief.fillFromPostsPrompt") : t("settings.brief.interviewPrompt"),
              )
            }>
              {t("settings.brief.fill")}
            </Button>
          }
        >
          <form className="flex flex-col gap-4" onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("settings.brief.name")}>
                <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <Field label={t("settings.brief.cadence")} hint={t("settings.brief.cadenceHint")}>
                <Input type="number" min={0} max={14} step={0.5} value={draft.cadence} onChange={(e) => set("cadence", e.target.value)} />
              </Field>
            </div>
            <Field label={t("settings.brief.about")} hint={t("settings.brief.aboutHint")}>
              <Textarea rows={3} value={draft.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
            <Field label={t("settings.brief.readers")} hint={t("settings.brief.readersHint")}>
              <Textarea rows={2} value={draft.audience} onChange={(e) => set("audience", e.target.value)} />
            </Field>
            <Field label={t("settings.brief.voice")} hint={t("settings.brief.voiceHint")}>
              <Textarea rows={2} value={draft.voice} onChange={(e) => set("voice", e.target.value)} />
            </Field>
            <Field label={t("settings.brief.themes")} hint={t("settings.brief.themesHint")}>
              <Textarea rows={4} value={draft.pillars} onChange={(e) => set("pillars", e.target.value)} />
            </Field>
            <Field label={t("settings.brief.format")} hint={t("settings.brief.formatHint")}>
              <Textarea rows={3} value={draft.format} onChange={(e) => set("format", e.target.value)} />
            </Field>
            <Field label={t("settings.brief.avoid")} hint={t("settings.brief.avoidHint")}>
              <Textarea rows={2} value={draft.avoid} onChange={(e) => set("avoid", e.target.value)} />
            </Field>
            <Field label={t("settings.brief.examples")} hint={t("settings.brief.examplesHint")}>
              <Textarea rows={5} value={draft.examples} onChange={(e) => set("examples", e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("settings.brief.timeZone")} hint={t("settings.brief.timeZoneHint")}>
                <Input list="newsletter-zones" value={draft.timezone} onChange={(e) => set("timezone", e.target.value)} />
                <datalist id="newsletter-zones">
                  {ZONES.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </Field>
              <Field label={t("settings.brief.defaultAudience")}>
                <SimpleSelect<Audience>
                  label={t("settings.brief.defaultAudienceLabel")}
                  value={draft.default_audience}
                  onValueChange={(v) => set("default_audience", v)}
                  options={AUDIENCES.map((a) => ({ value: a.value, label: t(`audiences.${a.value}`) }))}
                />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" variant="solid" color="accent" size="sm" loading={saving} disabled={!dirty}>
                {t("settings.brief.save")}
              </Button>
              {saved && !dirty && <span className="text-[12px] text-t-text-tertiary">{t("common:saved")}</span>}
              {error && <span className="text-t-text-danger">{error}</span>}
            </div>
          </form>
        </Section>

        <Section title={t("settings.remove.title")} description={t("settings.remove.description")}>
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
                  {t("settings.remove.confirm", { name: newsletter.name })}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>{t("common:cancel")}</Button>
              </>
            ) : (
              <Button size="sm" variant="outline" color="danger" onClick={() => setConfirm("delete")}>
                {t("settings.remove.start")}
              </Button>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}
