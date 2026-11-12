import { useEffect, useState } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useRouteLoaderData,
} from "react-router";
import { LightIconButton } from "twenty-ui/components/input";
import { Skeleton } from "twenty-ui/primitives/feedback";
import { Button } from "twenty-ui/primitives/input";
import { ListItem } from "twenty-ui/primitives/navigation";
import { AlertDialog } from "twenty-ui/primitives/surfaces";
import {
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
  const inSocial = useLocation().pathname.startsWith("/social");
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
            aria-label="Projects"
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
                aria-label="Close the sidebar"
                tooltip="Close the sidebar"
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
              Search
            </ListItem>
            <ListItem
              render={<Link to="/" />}
              startIcon={
                <IconTile color="pink">
                  <IconSquareRoundedPlusFilled />
                </IconTile>
              }
              selected={!threadId && !inMail && !inSocial}
            >
              New project
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
              Mail
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
              Social
            </ListItem>

            <SectionLabel>Projects</SectionLabel>
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
                  Your projects show here.
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
                      aria-label={`Delete ${thread.title}`}
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
              <LightIconButton
                aria-label="Sign out"
                tooltip="Sign out"
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
                <AlertDialog.Title>Delete “{deleting?.title}”?</AlertDialog.Title>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <AlertDialog.Description>
                  The project and its conversation leave Richelieu for good. This cannot be undone.
                </AlertDialog.Description>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <AlertDialog.Close render={<Button variant="outline" />}>Cancel</AlertDialog.Close>
                <AlertDialog.Close
                  render={<Button variant="solid" color="danger" />}
                  onClick={() => {
                    if (deleting) void remove(deleting.id);
                  }}
                >
                  Delete the project
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
