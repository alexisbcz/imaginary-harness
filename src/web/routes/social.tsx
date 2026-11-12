import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { LightIconButton } from "twenty-ui/components/input";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button, Input } from "twenty-ui/primitives/input";
import { Tabs } from "twenty-ui/primitives/navigation";
import {
  IconBinocularsFilled,
  IconBuildingStore,
  IconCalendarFilled,
  IconChartAreaLineFilled,
  IconLayoutSidebarRightCollapse,
  IconPencilPlus,
  IconSparkles,
  IconSpeakerphone,
} from "@tabler/icons-react";

import { IconTile, NameTile } from "@/components/icon-tile";
import { Page } from "@/components/page";
import { SimpleSelect } from "@/components/simple-select";
import { SocialAnalytics } from "@/components/social/analytics";
import { BrandSettings } from "@/components/social/brand-settings";
import { SocialCalendar } from "@/components/social/calendar";
import { Copilot } from "@/components/social/copilot";
import { PostEditor } from "@/components/social/post-editor";
import { SocialWatchlist } from "@/components/social/watchlist";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useIsMobile } from "@/hooks/use-mobile";
import { sendMessage } from "@/lib/chat";
import {
  createBrand,
  useAccounts,
  useBrands,
  type Brand,
  type EditorRequest,
  type LinkableProfile,
  type SocialStatus,
} from "@/lib/social";

const VIEWS = [
  { value: "calendar", label: "Calendar", icon: IconCalendarFilled, color: "violet" as const },
  { value: "analytics", label: "Analytics", icon: IconChartAreaLineFilled, color: "green" as const },
  { value: "watchlist", label: "Watchlist", icon: IconBinocularsFilled, color: "orange" as const },
  { value: "brand", label: "Brand", icon: IconBuildingStore, color: "blue" as const },
];
type View = (typeof VIEWS)[number]["value"];

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The first brand: a name and a site, or a Zernio profile that already has accounts. */
function CreateBrand({
  status,
  linkable,
  onCreated,
  first,
}: {
  status: SocialStatus;
  linkable: LinkableProfile[];
  onCreated: (brand: Brand) => void;
  first: boolean;
}) {
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(link?: LinkableProfile) {
    setBusy(link?.id ?? "new");
    setError(null);
    try {
      onCreated(
        await createBrand({
          name: link ? (name.trim() || link.accounts[0] || link.name) : name.trim(),
          website: website.trim() || undefined,
          timezone: browserZone(),
          link_profile_id: link?.id,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-[480px] flex-col gap-5">
        <IconTile size="lg" color="violet">
          <IconSpeakerphone />
        </IconTile>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[22px] font-semibold text-t-text">
            {first ? "Your social media, run with an agent" : "A new brand"}
          </h1>
          <p className="leading-[1.55] text-t-text-secondary">
            Connect a brand's accounts, and Richelieu plans the calendar, writes posts in its voice, tracks what
            works, and keeps an eye on competitors. Nothing goes out until you approve it.
          </p>
        </div>
        {!status.publishing && (
          <p className="rounded-md border border-t-border bg-t-secondary px-3 py-2 text-t-text-secondary">
            Set <code>ZERNIO_API_KEY</code> in <code>.env</code> to connect accounts and publish.
          </p>
        )}
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) void create();
          }}
        >
          <Input
            aria-label="Brand name"
            placeholder="Brand or company name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
          <Input
            aria-label="Website"
            placeholder="Website (optional): the copilot reads it to learn the brand"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
          />
          <Button
            type="submit"
            variant="solid"
            color="accent"
            loading={busy === "new"}
            disabled={!name.trim() || busy !== null || !status.publishing}
          >
            Create the brand
          </Button>
        </form>
        {linkable.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[12px] font-medium text-t-text-tertiary">Or start from a Zernio profile you already have</p>
            {linkable.map((profile) => (
              <button
                key={profile.id}
                type="button"
                disabled={busy !== null}
                onClick={() => void create(profile)}
                className="flex items-center gap-3 rounded-md border border-t-border px-3 py-2 text-left hover:bg-t-hover disabled:opacity-60"
              >
                <NameTile name={profile.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-t-text">{profile.name}</span>
                  <span className="block truncate text-[12px] text-t-text-tertiary">
                    {profile.accounts.length ? profile.accounts.join(", ") : "No accounts"}
                  </span>
                </span>
                {busy === profile.id ? <Loader /> : <span className="text-[12px] text-t-text-secondary">Use</span>}
              </button>
            ))}
          </div>
        )}
        {error && <p className="text-t-text-danger">{error}</p>}
      </div>
    </div>
  );
}

/** A brand's social media: its calendar, analytics, watchlist and brief, with its copilot beside them. */
export function Social() {
  const { brandId, view: viewParam } = useParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { data, error, reload } = useBrands();
  const brands = data?.brands ?? null;
  const brand = brands?.find((b) => b.id === brandId) ?? null;
  const view: View = (VIEWS.some((v) => v.value === viewParam) ? viewParam : "calendar") as View;
  const [creating, setCreating] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(() => window.innerWidth >= 1100);
  const [editor, setEditor] = useState<EditorRequest | null>(null);
  const [revision, setRevision] = useState(0);
  const [copilotRevision, setCopilotRevision] = useState("");
  const accounts = useAccounts(brand?.id ?? "");

  // /social goes to the first brand.
  useEffect(() => {
    if (brands?.length && !brand && !creating) navigate(`/social/${brands[0]!.id}/calendar`, { replace: true });
  }, [brands, brand, creating, navigate]);

  // Coming back from connecting an account: read the accounts again.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("connected")) void accounts.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand?.id]);

  const ask = useCallback(
    (message: string) => {
      if (!brand?.thread_id) return;
      setCopilotOpen(true);
      void sendMessage(brand.thread_id, { content: message });
    },
    [brand?.thread_id],
  );

  if (error && !brands)
    return (
      <Page title="Social" icon={<IconTile color="violet"><IconSpeakerphone /></IconTile>}>
        <p className="m-auto text-t-text-danger">{error}</p>
      </Page>
    );
  if (!brands || !data)
    return (
      <Page title="Social" icon={<IconTile color="violet"><IconSpeakerphone /></IconTile>}>
        <div className="m-auto">
          <Loader />
        </div>
      </Page>
    );
  if (brands.length === 0 || creating || !brand)
    return (
      <Page
        title="Social"
        icon={<IconTile color="violet"><IconSpeakerphone /></IconTile>}
        actions={
          creating && brands.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          ) : undefined
        }
      >
        {brands.length > 0 && !creating && !brand ? (
          <div className="m-auto">
            <Loader />
          </div>
        ) : (
          <CreateBrand
            first={brands.length === 0}
            status={data.status}
            linkable={data.linkable}
            onCreated={(created) => {
              setCreating(false);
              void reload();
              navigate(`/social/${created.id}/${created.website || created.zernio_profile_owned ? "brand" : "calendar"}`);
              // A new brand with a website: the copilot starts by learning it.
              if (created.website && created.thread_id)
                void sendMessage(created.thread_id, {
                  content: `Here is our website: ${created.website}. Read it and fill in our brand brief (what we do, audience, voice, content pillars). Then tell me in a few lines what you understood, and which accounts I should connect.`,
                });
            }}
          />
        )}
      </Page>
    );

  const viewProps = {
    brand,
    accounts: accounts.data,
    revision: `${revision}:${copilotRevision}`,
    onCompose: setEditor,
    onAsk: ask,
  };

  const content = (
    <Tabs.Root
      value={view}
      onValueChange={(value) => navigate(`/social/${brand.id}/${value}`)}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex h-10 shrink-0 items-end">
        <Tabs.List aria-label="Social views" className="relative w-full overflow-x-auto px-3">
          {VIEWS.map(({ value, label, icon: TabIcon, color }) => (
            <Tabs.Tab
              key={value}
              value={value}
              startIcon={
                <IconTile size="xs" color={color}>
                  <TabIcon />
                </IconTile>
              }
            >
              {label}
            </Tabs.Tab>
          ))}
          <Tabs.Indicator />
        </Tabs.List>
      </div>
      <Tabs.Panel value="calendar" className="min-h-0 flex-1">
        {view === "calendar" && <SocialCalendar {...viewProps} />}
      </Tabs.Panel>
      <Tabs.Panel value="analytics" className="min-h-0 flex-1">
        {view === "analytics" && <SocialAnalytics {...viewProps} />}
      </Tabs.Panel>
      <Tabs.Panel value="watchlist" className="min-h-0 flex-1">
        {view === "watchlist" && <SocialWatchlist {...viewProps} />}
      </Tabs.Panel>
      <Tabs.Panel value="brand" className="min-h-0 flex-1">
        {view === "brand" && (
          <BrandSettings
            {...viewProps}
            onAccountsChanged={() => void accounts.reload()}
            onDeleted={() => {
              void reload();
              navigate("/social", { replace: true });
            }}
          />
        )}
      </Tabs.Panel>
    </Tabs.Root>
  );

  const copilot = brand.thread_id ? (
    <Copilot
      brand={brand}
      accounts={accounts.data}
      onActivity={setCopilotRevision}
      onClose={isMobile ? () => setCopilotOpen(false) : undefined}
    />
  ) : null;

  return (
    <Page
      title={
        <SimpleSelect
          label="Brand"
          bare
          value={brand.id}
          onValueChange={(id) => (id === "new" ? setCreating(true) : navigate(`/social/${id}/${view}`))}
          options={[
            ...brands.map((b) => ({ value: b.id, label: b.name })),
            { value: "new", label: "New brand…" },
          ]}
          className="-ml-2 font-medium"
        />
      }
      icon={<NameTile name={brand.name} />}
      actions={
        <>
          <Button
            size="sm"
            variant="solid"
            color="accent"
            startIcon={<IconPencilPlus size={14} />}
            onClick={() => setEditor({})}
          >
            New post
          </Button>
          <LightIconButton
            aria-label={copilotOpen ? "Hide the copilot" : "Show the copilot"}
            tooltip={copilotOpen ? "Hide the copilot" : "Show the copilot"}
            onClick={() => setCopilotOpen((open) => !open)}
          >
            {copilotOpen ? <IconLayoutSidebarRightCollapse size={16} /> : <IconSparkles size={16} />}
          </LightIconButton>
        </>
      }
    >
      {isMobile ? (
        copilotOpen && copilot ? copilot : content
      ) : copilotOpen && copilot ? (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="68" minSize="45">
            {content}
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="32" minSize="24">
            {copilot}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        content
      )}
      {editor && (
        <PostEditor
          brand={brand}
          accounts={accounts.data ?? []}
          request={editor}
          onClose={() => setEditor(null)}
          onSaved={() => setRevision((r) => r + 1)}
          onAsk={ask}
        />
      )}
    </Page>
  );
}
