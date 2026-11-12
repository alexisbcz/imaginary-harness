// The brand's page: its connected accounts (connected through Zernio's sign-in flow), and its brief: what the copilot
// and the composer's rewrites write from.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button, Input, Textarea } from "twenty-ui/primitives/input";
import { IconCircleCheck, IconExternalLink, IconSparkles } from "@tabler/icons-react";
import { cn } from "cn";

import { AccountAvatar, PlatformTile } from "@/components/social/platform-icon";
import {
  connectAccount,
  deleteBrand,
  disconnectAccount,
  PLATFORMS,
  platformInfo,
  updateBrand,
  type Brand,
  type BrandViewProps,
} from "@/lib/social";

function Section({ title, description, children, actions }: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-t-text-secondary">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-t-text-light">{hint}</span>}
    </label>
  );
}

type Draft = Pick<
  Brand,
  "name" | "website" | "description" | "audience" | "voice" | "avoid" | "examples" | "timezone"
> & { pillars: string; cadence: Record<string, string> };

const draftOf = (brand: Brand): Draft => ({
  name: brand.name,
  website: brand.website,
  description: brand.description,
  audience: brand.audience,
  voice: brand.voice,
  avoid: brand.avoid,
  examples: brand.examples,
  timezone: brand.timezone,
  pillars: brand.pillars.join("\n"),
  cadence: Object.fromEntries(Object.entries(brand.cadence).map(([k, v]) => [k, String(v)])),
});

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return [];
  }
})();

export function BrandSettings({
  brand,
  accounts,
  onAsk,
  onAccountsChanged,
  onDeleted,
}: BrandViewProps & { onAccountsChanged: () => void; onDeleted: () => void }) {
  const [params, setParams] = useSearchParams();
  const connected = params.get("connected");
  const [draft, setDraft] = useState(() => draftOf(brand));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // The brief changes elsewhere too (the copilot's update_brand_brief): follow it unless the user is editing.
  const initial = useMemo(() => draftOf(brand), [brand]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const [touched, setTouched] = useState(false);
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
      await updateBrand(brand.id, {
        ...draft,
        pillars: draft.pillars.split(/\n|;/).map((p) => p.trim()).filter(Boolean),
        cadence: Object.fromEntries(
          Object.entries(draft.cadence)
            .map(([k, v]) => [k, Number(v)] as const)
            .filter(([, v]) => v > 0),
        ),
      });
      setTouched(false);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function connect(platform: string) {
    setConnecting(platform);
    setError(null);
    try {
      await connectAccount(brand.id, platform);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConnecting(null);
    }
  }

  async function disconnect(accountId: string) {
    setBusy(accountId);
    try {
      await disconnectAccount(brand.id, accountId);
      onAccountsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  async function remove() {
    setBusy("brand");
    try {
      await deleteBrand(brand.id);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  const platformsPresent = [...new Set((accounts ?? []).map((a) => a.platform))];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-10 px-5 py-6">
        {connected && (
          <div className="flex items-center gap-2 rounded-md border border-t-border bg-t-secondary px-3 py-2 text-t-text">
            <IconCircleCheck size={16} className="text-[var(--t-color-green9)]" />
            <span className="flex-1">
              {platformInfo(connected).label} is connected. Your copilot can now plan and draft posts for it.
            </span>
            <Button size="sm" variant="ghost" onClick={() => setParams({}, { replace: true })}>
              Dismiss
            </Button>
          </div>
        )}

        <Section
          title="Accounts"
          description="Where the brand posts. Accounts connect through each platform's own sign-in; Richelieu never sees passwords."
        >
          {accounts === null ? (
            <div className="flex h-16 items-center justify-center">
              <Loader />
            </div>
          ) : accounts.length > 0 ? (
            <ul className="flex flex-col divide-y divide-t-border-light rounded-md border border-t-border">
              {accounts.map((account) => (
                <li key={account.id} className="flex items-center gap-3 px-3 py-2.5">
                  <AccountAvatar avatar={account.avatar} platform={account.platform} name={account.name} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-t-text">{account.name}</div>
                    <div className="truncate text-[12px] text-t-text-tertiary">
                      {platformInfo(account.platform).label}
                      {account.username !== account.name ? ` · ${account.username}` : ""}
                      {!account.active && " · needs reconnecting"}
                    </div>
                  </div>
                  {account.url && (
                    <a
                      href={account.url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded p-1 text-t-text-tertiary hover:bg-t-hover hover:text-t-text"
                      aria-label={`Open ${account.name} on ${platformInfo(account.platform).label}`}
                    >
                      <IconExternalLink size={15} />
                    </a>
                  )}
                  {confirm === account.id ? (
                    <span className="flex items-center gap-1.5">
                      <span className="text-[12px] text-t-text-secondary">Disconnect?</span>
                      <Button size="sm" variant="solid" color="danger" loading={busy === account.id} onClick={() => void disconnect(account.id)}>
                        Disconnect
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(account.id)}>
                      Disconnect
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-md border border-dashed border-t-border px-4 py-3 text-t-text-secondary">
              No account yet. Connect one below: the copilot can write drafts before, but nothing can be scheduled.
            </p>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2">
            {PLATFORMS.filter((p) => p.connectable).map((platform) => (
              <button
                key={platform.id}
                type="button"
                disabled={connecting !== null}
                onClick={() => void connect(platform.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md border border-t-border px-2.5 py-2 text-left transition-colors hover:bg-t-hover disabled:opacity-60",
                )}
              >
                <PlatformTile platform={platform.id} />
                <span className="min-w-0 flex-1 truncate text-t-text">{platform.label}</span>
                {connecting === platform.id ? (
                  <Loader />
                ) : (
                  <span className="text-[12px] text-t-text-tertiary">
                    {platformsPresent.includes(platform.id) ? "Add" : "Connect"}
                  </span>
                )}
              </button>
            ))}
          </div>
        </Section>

        <Section
          title="Brief"
          description="What every post is written from. The copilot fills it from your website, and keeps it up to date as it learns."
          actions={
            <Button
              size="sm"
              variant="outline"
              startIcon={<IconSparkles size={14} />}
              onClick={() =>
                onAsk(
                  draft.website || brand.website
                    ? `Read our website ${draft.website || brand.website} and our recent posts, then improve our brand brief: what we do, audience, voice, content pillars, what to avoid, and two example posts. Tell me what you changed.`
                    : "Ask me the questions you need to write our brand brief (what we do, audience, voice, content pillars, what to avoid), then save it.",
                )
              }
            >
              Fill with the copilot
            </Button>
          }
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <Field label="Website">
                <Input value={draft.website} placeholder="https://" onChange={(e) => set("website", e.target.value)} />
              </Field>
            </div>
            <Field label="What the brand does" hint="Products, what makes them different, proof points.">
              <Textarea rows={3} value={draft.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
            <Field label="Audience" hint="Who reads the posts, and what they care about.">
              <Textarea rows={2} value={draft.audience} onChange={(e) => set("audience", e.target.value)} />
            </Field>
            <Field label="Voice" hint="How it sounds: e.g. “direct, warm, first person plural, no jargon, one emoji at most”.">
              <Textarea rows={2} value={draft.voice} onChange={(e) => set("voice", e.target.value)} />
            </Field>
            <Field label="Content pillars" hint="The themes it posts about, one per line.">
              <Textarea rows={4} value={draft.pillars} onChange={(e) => set("pillars", e.target.value)} />
            </Field>
            <Field label="Never" hint="Words, topics or habits to avoid.">
              <Textarea rows={2} value={draft.avoid} onChange={(e) => set("avoid", e.target.value)} />
            </Field>
            <Field label="Example posts" hint="Two or three posts that sound exactly right.">
              <Textarea rows={5} value={draft.examples} onChange={(e) => set("examples", e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Time zone" hint="Posts are planned and analyzed in it.">
                <Input list="social-zones" value={draft.timezone} onChange={(e) => set("timezone", e.target.value)} />
                <datalist id="social-zones">
                  {ZONES.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </Field>
            </div>
            {platformsPresent.length > 0 && (
              <Field label="Posts per week" hint="The copilot plans towards these goals.">
                <div className="flex flex-wrap gap-2">
                  {platformsPresent.map((platform) => (
                    <span key={platform} className="flex items-center gap-2 rounded-md border border-t-border py-1 pr-1 pl-2">
                      <PlatformTile platform={platform} size="xs" />
                      <span className="text-t-text-secondary">{platformInfo(platform).label}</span>
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        aria-label={`Posts per week on ${platformInfo(platform).label}`}
                        className="w-16 tabular-nums"
                        value={draft.cadence[platform] ?? ""}
                        placeholder="0"
                        onChange={(e) => set("cadence", { ...draft.cadence, [platform]: e.target.value })}
                      />
                    </span>
                  ))}
                </div>
              </Field>
            )}
            <div className="flex items-center gap-3">
              <Button type="submit" variant="solid" color="accent" size="sm" loading={saving} disabled={!dirty}>
                Save the brief
              </Button>
              {saved && !dirty && <span className="text-[12px] text-t-text-tertiary">Saved</span>}
              {error && <span className="text-t-text-danger">{error}</span>}
            </div>
          </form>
        </Section>

        <Section
          title="Delete the brand"
          description={
            brand.zernio_profile_owned
              ? "Removes its brief, watchlist and copilot conversation, disconnects its accounts and deletes its Zernio profile. Published posts stay on the platforms."
              : "Removes its brief, watchlist and copilot conversation. Its Zernio profile and accounts stay as they were."
          }
        >
          <div className="flex items-center gap-2">
            {confirm === "brand" ? (
              <>
                <Button size="sm" variant="solid" color="danger" loading={busy === "brand"} onClick={() => void remove()}>
                  Delete {brand.name}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" color="danger" onClick={() => setConfirm("brand")}>
                Delete the brand…
              </Button>
            )}
          </div>
        </Section>

      </div>
    </div>
  );
}
