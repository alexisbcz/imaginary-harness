// A Substack newsletter run from Richelieu: its posts and the editor, ideas, Notes, analytics and settings, with
// its copilot beside them. /newsletter/:newsletterId/:view/:postId.

import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { LightIconButton } from "twenty-ui/components/input";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button, Input } from "twenty-ui/primitives/input";
import { Tabs } from "twenty-ui/primitives/navigation";
import {
  IconAlertTriangle,
  IconBulb,
  IconChartAreaLineFilled,
  IconFileTextFilled,
  IconLayoutSidebarRightCollapse,
  IconNews,
  IconNotes,
  IconSettingsFilled,
  IconSparkles,
} from "@tabler/icons-react";

import { IconTile, NameTile } from "@/components/icon-tile";
import { NewsletterAnalytics } from "@/components/newsletter/analytics";
import { NewsletterCopilot } from "@/components/newsletter/copilot";
import { PostEditor } from "@/components/newsletter/editor";
import { NewsletterIdeas } from "@/components/newsletter/ideas";
import { NewsletterNotes } from "@/components/newsletter/notes";
import { NewsletterPosts } from "@/components/newsletter/posts";
import { CookieHelp, NewsletterSettings } from "@/components/newsletter/settings";
import { Page } from "@/components/page";
import { SimpleSelect } from "@/components/simple-select";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useIsMobile } from "@/hooks/use-mobile";
import { sendMessage } from "@/lib/chat";
import { createNewsletter, useNewsletters, type Newsletter } from "@/lib/newsletter";

// Each tab's label is `page.views.<value>`.
const VIEWS = [
  { value: "posts", icon: IconFileTextFilled, color: "orange" as const },
  { value: "ideas", icon: IconBulb, color: "amber" as const },
  { value: "notes", icon: IconNotes, color: "blue" as const },
  { value: "analytics", icon: IconChartAreaLineFilled, color: "green" as const },
  { value: "settings", icon: IconSettingsFilled, color: "gray" as const },
] as const;
type View = (typeof VIEWS)[number]["value"];

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const pageIcon = (
  <IconTile color="orange">
    <IconNews />
  </IconTile>
);

/** The first screen: connect a Substack publication, or start without one. */
function CreateNewsletter({ first, onCreated }: { first: boolean; onCreated: (n: Newsletter) => void }) {
  const { t } = useTranslation(["newsletter", "common"]);
  const [publication, setPublication] = useState("");
  const [cookie, setCookie] = useState("");
  const [busy, setBusy] = useState<null | "connect" | "later">(null);
  const [error, setError] = useState<string | null>(null);

  async function create(withCookie: boolean) {
    setBusy(withCookie ? "connect" : "later");
    setError(null);
    try {
      onCreated(
        await createNewsletter({
          publication: publication.trim() || undefined,
          cookie: withCookie ? cookie : undefined,
          timezone: browserZone(),
          name: withCookie ? undefined : publication.trim().replace(/^https?:\/\//, "").split(".")[0] || undefined,
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
      <div className="flex w-full max-w-[500px] flex-col gap-5">
        <IconTile size="lg" color="orange">
          <IconNews />
        </IconTile>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[22px] font-semibold text-t-text">{first ? t("create.firstTitle") : t("create.anotherTitle")}</h1>
          <p className="leading-[1.55] text-t-text-secondary">
            {t("create.intro")}
          </p>
        </div>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (cookie.trim()) void create(true);
          }}
        >
          <Input aria-label={t("create.publication")} placeholder={t("create.publicationPlaceholder")} value={publication} onChange={(e) => setPublication(e.target.value)} autoFocus />
          <Input aria-label={t("create.cookie")} type="password" autoComplete="off" placeholder={t("create.cookiePlaceholder")} value={cookie} onChange={(e) => setCookie(e.target.value)} />
          <CookieHelp />
          <Button type="submit" variant="solid" color="accent" loading={busy === "connect"} disabled={!cookie.trim() || busy !== null}>
            {t("settings.connect.connect")}
          </Button>
          <Button variant="ghost" loading={busy === "later"} disabled={busy !== null} onClick={() => void create(false)}>
            {t("create.later")}
          </Button>
        </form>
        {error && <p className="text-t-text-danger">{error}</p>}
      </div>
    </div>
  );
}

export function NewsletterPage() {
  const { t } = useTranslation(["newsletter", "common"]);
  const { newsletterId, view: viewParam, postId: postParam } = useParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { data, error, reload } = useNewsletters();
  const newsletters = data?.newsletters ?? null;
  const newsletter = newsletters?.find((n) => n.id === newsletterId) ?? null;
  const view: View = (VIEWS.some((v) => v.value === viewParam) ? viewParam : "posts") as View;
  const postId = view === "posts" && postParam && /^\d+$/.test(postParam) ? Number(postParam) : null;
  const [creating, setCreating] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(() => window.innerWidth >= 1100);
  // What the copilot touched, and what the views changed themselves: both reload the posts.
  const [copilotRevision, setCopilotRevision] = useState("");
  const [localRevision, setLocalRevision] = useState(0);

  useEffect(() => {
    if (newsletters?.length && !newsletter && !creating) navigate(`/newsletter/${newsletters[0]!.id}/posts`, { replace: true });
  }, [newsletters, newsletter, creating, navigate]);

  const ask = useCallback(
    (message: string) => {
      if (!newsletter?.thread_id) return;
      setCopilotOpen(true);
      void sendMessage(newsletter.thread_id, { content: message });
    },
    [newsletter?.thread_id],
  );
  const changed = useCallback(() => setLocalRevision((r) => r + 1), []);
  const openPost = useCallback((id: number) => newsletter && navigate(`/newsletter/${newsletter.id}/posts/${id}`), [newsletter, navigate]);

  if (error && !newsletters)
    return (
      <Page title={t("common:sections.newsletter")} icon={pageIcon}>
        <p className="m-auto text-t-text-danger">{error}</p>
      </Page>
    );
  if (!newsletters || !data)
    return (
      <Page title={t("common:sections.newsletter")} icon={pageIcon}>
        <div className="m-auto">
          <Loader />
        </div>
      </Page>
    );
  if (newsletters.length === 0 || creating || !newsletter)
    return (
      <Page
        title={t("common:sections.newsletter")}
        icon={pageIcon}
        actions={
          creating && newsletters.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>{t("common:cancel")}</Button>
          ) : undefined
        }
      >
        {newsletters.length > 0 && !creating && !newsletter ? (
          <div className="m-auto">
            <Loader />
          </div>
        ) : (
          <CreateNewsletter
            first={newsletters.length === 0}
            onCreated={(created) => {
              setCreating(false);
              void reload();
              navigate(`/newsletter/${created.id}/${created.connected_at ? "posts" : "settings"}`);
            }}
          />
        )}
      </Page>
    );

  const needsConnection = !newsletter.connected_at && ["posts", "analytics"].includes(view);

  const content = (
    <Tabs.Root value={view} onValueChange={(value) => navigate(`/newsletter/${newsletter.id}/${value}`)} className="flex h-full min-h-0 flex-col">
      {!postId && (
        <div className="flex h-10 shrink-0 items-end">
          <Tabs.List aria-label={t("page.views.label")} className="relative w-full overflow-x-auto px-3">
            {VIEWS.map(({ value, icon: TabIcon, color }) => (
              <Tabs.Tab
                key={value}
                value={value}
                startIcon={
                  <IconTile size="xs" color={color}>
                    <TabIcon />
                  </IconTile>
                }
              >
                {t(`page.views.${value}`)}
              </Tabs.Tab>
            ))}
            <Tabs.Indicator />
          </Tabs.List>
        </div>
      )}
      {newsletter.connection_error && !postId && (
        <div className="flex items-center gap-2 border-b border-t-border-light bg-t-secondary px-4 py-2 text-t-text">
          <IconAlertTriangle size={16} className="shrink-0 text-[var(--t-color-orange9)]" />
          <span className="min-w-0 flex-1 truncate">{t("page.sessionRefused")}</span>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/newsletter/${newsletter.id}/settings`)}>{t("page.views.settings")}</Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {needsConnection ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="max-w-[420px] text-t-text-secondary">{t("page.needsConnection")}</p>
            <Button size="sm" variant="solid" color="accent" onClick={() => navigate(`/newsletter/${newsletter.id}/settings`)}>
              {t("settings.connect.connect")}
            </Button>
          </div>
        ) : view === "posts" && postId ? (
          <PostEditor
            key={postId}
            newsletter={newsletter}
            postId={postId}
            revision={copilotRevision}
            onBack={() => navigate(`/newsletter/${newsletter.id}/posts`)}
            onAsk={ask}
            onChanged={changed}
          />
        ) : view === "posts" ? (
          <NewsletterPosts newsletter={newsletter} revision={`${copilotRevision}:${localRevision}`} onOpen={openPost} onAsk={ask} />
        ) : view === "ideas" ? (
          <NewsletterIdeas newsletter={newsletter} onOpenPost={openPost} onAsk={ask} />
        ) : view === "notes" ? (
          <NewsletterNotes newsletter={newsletter} onAsk={ask} />
        ) : view === "analytics" ? (
          <NewsletterAnalytics newsletter={newsletter} onAsk={ask} />
        ) : (
          <NewsletterSettings
            newsletter={newsletter}
            status={data.status}
            onAsk={ask}
            onDeleted={() => {
              void reload();
              navigate("/newsletter", { replace: true });
            }}
          />
        )}
      </div>
    </Tabs.Root>
  );

  const copilot = newsletter.thread_id ? (
    <NewsletterCopilot
      newsletter={newsletter}
      postId={postId}
      onActivity={setCopilotRevision}
      onClose={isMobile ? () => setCopilotOpen(false) : undefined}
    />
  ) : null;

  return (
    <Page
      title={
        <SimpleSelect
          label={t("common:sections.newsletter")}
          bare
          value={newsletter.id}
          onValueChange={(id) => (id === "new" ? setCreating(true) : navigate(`/newsletter/${id}/${view}`))}
          options={[...newsletters.map((n) => ({ value: n.id, label: n.name })), { value: "new", label: t("page.newNewsletter") }]}
          className="-ml-2 font-medium"
        />
      }
      icon={newsletter.logo_url ? <img src={newsletter.logo_url} alt="" className="size-5 rounded" /> : <NameTile name={newsletter.name} />}
      actions={
        <LightIconButton
          aria-label={copilotOpen ? t("page.hideCopilot") : t("page.showCopilot")}
          tooltip={copilotOpen ? t("page.hideCopilot") : t("page.showCopilot")}
          onClick={() => setCopilotOpen((open) => !open)}
        >
          {copilotOpen ? <IconLayoutSidebarRightCollapse size={16} /> : <IconSparkles size={16} />}
        </LightIconButton>
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
    </Page>
  );
}
