import { useEffect, useState } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useRouteLoaderData,
} from "react-router";
import { useTranslation } from "react-i18next";
import { setLanguage } from "@/lib/i18n";
import { LANGUAGES } from "@/locales";
import { LightIconButton } from "twenty-ui/components/input";
import { Skeleton } from "twenty-ui/primitives/feedback";
import { Button } from "twenty-ui/primitives/input";
import { ListItem } from "twenty-ui/primitives/navigation";
import { AlertDialog } from "twenty-ui/primitives/surfaces";
import {
  IconNews,
  IconSpeakerphone,
  IconSquareRoundedPlusFilled,
} from "@tabler/icons-react";
import {
  IconLayoutSidebarLeftCollapse,
  IconLogout,
  IconMail,
  IconSearch,
  IconTrash,
} from "twenty-ui/icon";

import { CommandMenu, useCommandMenuShortcut } from "@/components/command-menu";
import { IconTile, NameTile } from "@/components/icon-tile";
import { Logo } from "@/components/logo";
import { DrawerContext } from "@/components/page";
import { useIsMobile } from "@/hooks/use-mobile";
import type { Thread } from "@/lib/chat";
import { useUnreadCount } from "@/lib/mail";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

/** The signed-in user's projects, newest first, kept current through Realtime. */
function useThreads() {
  const [threads, setThreads] = useState<Thread[] | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data } = await supabase
        .from("threads")
        .select("id, title, updated_at")
        .eq("kind", "project")
        .order("updated_at", { ascending: false });
      if (active && data) setThreads(data);
    };
    const channel = supabase
      .channel("threads")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "threads" },
        () => void load(),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void load();
      });
    void load();
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, []);

  return [threads, setThreads] as const;
}

export type LayoutContext = { threads: Thread[] | null };

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pt-4 pb-1 text-[11px] font-semibold text-t-text-light">
      {children}
    </div>
  );
}

export function AppLayout() {
  const { name } = useRouteLoaderData("app") as { name: string };
  const { threadId } = useParams();
  const navigate = useNavigate();
  const [threads, setThreads] = useThreads();
  const unread = useUnreadCount();
  const inMail = useLocation().pathname.startsWith("/mail");
  const { t } = useTranslation("layout");
  const { t: tc } = useTranslation("common");
  const inSocial = useLocation().pathname.startsWith("/social");
  const inNewsletter = useLocation().pathname.startsWith("/newsletter");
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(true);
  // On a phone the drawer covers the page, starts closed, and closes on each navigation.
  const [mobileOpen, setMobileOpen] = useState(false);
  const drawerOpen = isMobile ? mobileOpen : open;
  const setDrawerOpen = isMobile ? setMobileOpen : setOpen;
  const { pathname } = useLocation();
  useEffect(() => setMobileOpen(false), [pathname]);
  const [menuOpen, setMenuOpen] = useState(false);
  useCommandMenuShortcut(() => setMenuOpen((current) => !current));

  // The project the user asked to delete, awaiting their confirmation.
  const [deleting, setDeleting] = useState<Thread | null>(null);

  async function remove(id: string) {
    setThreads(
      (current) => current?.filter((thread) => thread.id !== id) ?? null,
    );
    if (id === threadId) void navigate("/");
    await supabase.from("threads").delete().eq("id", id);
  }

  return (
    <DrawerContext value={{ open: drawerOpen, setOpen: setDrawerOpen }}>
      <div className="flex h-svh overflow-hidden bg-t-secondary">
        {drawerOpen && (
          <nav
            aria-label={t("sidebar.projectsLabel")}
            className={
              isMobile
                ? "fixed inset-y-0 left-0 z-50 flex w-[264px] flex-col bg-t-secondary px-2 pb-2 shadow-xl"
                : "flex w-[232px] shrink-0 flex-col px-2 pb-2"
            }
          >
            <div className="flex h-12 shrink-0 items-center gap-2 px-1">
              <Link
                to="/"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Logo size={22} />
                <span className="truncate font-semibold text-t-text">
                  Richelieu
                </span>
              </Link>
              <LightIconButton
                aria-label={t("sidebar.close")}
                tooltip={t("sidebar.close")}
                size="sm"
                onClick={() => setDrawerOpen(false)}
              >
                <IconLayoutSidebarLeftCollapse size={16} />
              </LightIconButton>
            </div>

            <ListItem
              render={<button type="button" />}
              startIcon={
                <IconTile>
                  <IconSearch />
                </IconTile>
              }
              shortcut={["Mod", "K"]}
              onClick={() => setMenuOpen(true)}
            >
              {t("sidebar.search")}
            </ListItem>
            <ListItem
              render={<Link to="/" />}
              startIcon={
                <IconTile color="pink">
                  <IconSquareRoundedPlusFilled />
                </IconTile>
              }
              selected={!threadId && !inMail && !inSocial && !inNewsletter}
            >
              {tc("sections.newProject")}
            </ListItem>
            <ListItem
              render={<Link to="/mail" />}
              startIcon={
                <IconTile color="blue">
                  <IconMail />
                </IconTile>
              }
              selected={inMail}
              description={
                unread > 0 ? (
                  <span className="tabular-nums">
                    {unread > 999 ? "999+" : unread}
                  </span>
                ) : undefined
              }
              descriptionPlacement="end"
            >
              {tc("sections.mail")}
            </ListItem>
            <ListItem
              render={<Link to="/social" />}
              startIcon={
                <IconTile color="violet">
                  <IconSpeakerphone />
                </IconTile>
              }
              selected={inSocial}
            >
              {tc("sections.social")}
            </ListItem>
            <ListItem
              render={<Link to="/newsletter" />}
              startIcon={
                <IconTile color="orange">
                  <IconNews />
                </IconTile>
              }
              selected={inNewsletter}
            >
              {tc("sections.newsletter")}
            </ListItem>

            <SectionLabel>{tc("sections.projects")}</SectionLabel>
            <div className="-mx-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2">
              {threads === null &&
                Array.from({ length: 4 }, (_, index) => (
                  <div key={index} className="flex h-7 items-center gap-2 px-1">
                    <Skeleton width={14} height={14} borderRadius={3} />
                    <Skeleton
                      width={`${50 + ((index * 17) % 40)}%`}
                      height={10}
                    />
                  </div>
                ))}
              {threads?.length === 0 && (
                <p className="px-1 py-1 text-t-text-tertiary">
                  {t("sidebar.empty")}
                </p>
              )}
              {threads?.map((thread) => (
                <ListItem
                  key={thread.id}
                  render={<Link to={`/t/${thread.id}`} />}
                  selected={thread.id === threadId}
                  startIcon={<NameTile name={thread.title} />}
                  actionsVisibility="hover"
                  actions={
                    <LightIconButton
                      aria-label={t("sidebar.deleteProject", { title: thread.title })}
                      size="xs"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setDeleting(thread);
                      }}
                    >
                      <IconTrash size={14} />
                    </LightIconButton>
                  }
                >
                  {thread.title}
                </ListItem>
              ))}
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-t-border-light px-1 pt-2">
              <NameTile name={name} round />
              <span className="min-w-0 flex-1 truncate text-t-text-secondary">
                {name}
              </span>
              <LanguageToggle />
              <LightIconButton
                aria-label={t("sidebar.signOut")}
                tooltip={t("sidebar.signOut")}
                size="sm"
                onClick={() => void supabase.auth.signOut()}
              >
                <IconLogout size={16} />
              </LightIconButton>
            </div>
          </nav>
        )}
        {isMobile && drawerOpen && (
          <div
            aria-hidden
            className="fixed inset-0 z-40 bg-black/20"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <Outlet context={{ threads } satisfies LayoutContext} />
      </div>
      <AlertDialog.Root
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop />
          <AlertDialog.Viewport>
            <AlertDialog.Popup size="sm">
              <AlertDialog.Header>
                <AlertDialog.Title>{t("sidebar.deleteTitle", { title: deleting?.title ?? "" })}</AlertDialog.Title>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <AlertDialog.Description>
                  {t("sidebar.deleteBody")}
                </AlertDialog.Description>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <AlertDialog.Close render={<Button variant="outline" />}>{tc("cancel")}</AlertDialog.Close>
                <AlertDialog.Close
                  render={<Button variant="solid" color="danger" />}
                  onClick={() => {
                    if (deleting) void remove(deleting.id);
                  }}
                >
                  {t("sidebar.deleteConfirm")}
                </AlertDialog.Close>
              </AlertDialog.Footer>
            </AlertDialog.Popup>
          </AlertDialog.Viewport>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      <CommandMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        threads={threads}
      />
    </DrawerContext>
  );
}

/** EN / FR, beside the user's name: switches the whole app's language. */
function LanguageToggle() {
  const { t, i18n } = useTranslation("common");
  const next = LANGUAGES.find((l) => l.code !== i18n.resolvedLanguage) ?? LANGUAGES[0];
  return (
    <button
      type="button"
      aria-label={`${t("language.change")}: ${next.label}`}
      title={`${t("language.change")}: ${next.label}`}
      onClick={() => setLanguage(next.code)}
      className="h-6 shrink-0 rounded-md px-1.5 text-[11px] font-semibold tracking-wide text-t-text-tertiary uppercase hover:bg-t-hover hover:text-t-text"
    >
      {/* i18n-ignore: the language codes read the same everywhere */}
      {next.code}
    </button>
  );
}
