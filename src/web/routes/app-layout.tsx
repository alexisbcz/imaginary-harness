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
  IconMessageCircleFilled,
  IconMessageCirclePlus,
  IconNews,
  IconSpeakerphone,
} from "@tabler/icons-react";
import {
  IconLayoutSidebarLeftCollapse,
  IconLogout,
  IconMail,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
} from "twenty-ui/icon";

import { CommandMenu, useCommandMenuShortcut } from "@/components/command-menu";
import { IconTile, NameTile } from "@/components/icon-tile";
import { Logo } from "@/components/logo";
import { DrawerContext } from "@/components/page";
import { useIsMobile } from "@/hooks/use-mobile";
import { NameDialog } from "@/components/name-dialog";
import { chatPath, deleteChat, renameChat, type Thread } from "@/lib/chat";
import { useUnreadCount } from "@/lib/mail";
import {
  createProject,
  deleteProject,
  PROJECT_NAME_LENGTH,
  updateProject,
  useLibrary,
  type Project,
} from "@/lib/projects";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

/** A project or a chat the user asked to rename or delete. */
export type Target = { kind: "project" | "chat"; id: string; name: string };

export type LayoutContext = {
  projects: Project[] | null;
  /** Every chat, in a project or not; the copilots' threads are left out. */
  chats: Thread[] | null;
  askCreateProject: () => void;
  askRename: (target: Target) => void;
  askDelete: (target: Target) => void;
};

function SectionLabel({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-8 items-end justify-between gap-1 px-1 pb-1 text-[11px] font-semibold text-t-text-light">
      <span>{children}</span>
      {action}
    </div>
  );
}

/** Rename and delete, shown on hover beside a project or a chat. */
function RowActions({
  target,
  onRename,
  onDelete,
  onNewChat,
}: {
  target: Target;
  onRename: (target: Target) => void;
  onDelete: (target: Target) => void;
  /** Projects: start a chat in it. */
  onNewChat?: () => void;
}) {
  const { t } = useTranslation("layout");
  const stop = (run: () => void) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  };
  return (
    <>
      {onNewChat && (
        <LightIconButton
          aria-label={t("sidebar.newChatIn", { name: target.name })}
          tooltip={t("sidebar.newChatIn", { name: target.name })}
          size="xs"
          onClick={stop(onNewChat)}
        >
          <IconPlus size={14} />
        </LightIconButton>
      )}
      <LightIconButton
        aria-label={t("sidebar.rename", { name: target.name })}
        size="xs"
        onClick={stop(() => onRename(target))}
      >
        <IconPencil size={14} />
      </LightIconButton>
      <LightIconButton
        aria-label={t("sidebar.delete", { name: target.name })}
        size="xs"
        onClick={stop(() => onDelete(target))}
      >
        <IconTrash size={14} />
      </LightIconButton>
    </>
  );
}

export function AppLayout() {
  const { name } = useRouteLoaderData("app") as { name: string };
  const { projectId, chatId } = useParams();
  const navigate = useNavigate();
  const { projects, setProjects, chats, setChats } = useLibrary();
  const unread = useUnreadCount();
  const { t } = useTranslation("layout");
  const { t: tc } = useTranslation("common");
  const { t: tp } = useTranslation("projects");
  const { pathname } = useLocation();
  const inMail = pathname.startsWith("/mail");
  const inSocial = pathname.startsWith("/social");
  const inNewsletter = pathname.startsWith("/newsletter");
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(true);
  // On a phone the drawer covers the page, starts closed, and closes on each navigation.
  const [mobileOpen, setMobileOpen] = useState(false);
  const drawerOpen = isMobile ? mobileOpen : open;
  const setDrawerOpen = isMobile ? setMobileOpen : setOpen;
  useEffect(() => setMobileOpen(false), [pathname]);
  const [menuOpen, setMenuOpen] = useState(false);
  useCommandMenuShortcut(() => setMenuOpen((current) => !current));

  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Target | null>(null);
  // What the user asked to delete, awaiting their confirmation.
  const [deleting, setDeleting] = useState<Target | null>(null);

  const plainChats = chats?.filter((chat) => chat.project_id === null) ?? null;
  const chatsOf = (id: string) => chats?.filter((chat) => chat.project_id === id) ?? [];

  async function rename(target: Target, next: string) {
    if (target.kind === "project") {
      await updateProject(target.id, { name: next });
      setProjects((current) =>
        current?.map((item) => (item.id === target.id ? { ...item, name: next } : item)) ?? null,
      );
    } else {
      await renameChat(target.id, next);
      setChats((current) =>
        current?.map((item) => (item.id === target.id ? { ...item, title: next } : item)) ?? null,
      );
    }
  }

  async function remove(target: Target) {
    if (target.kind === "project") {
      setProjects((current) => current?.filter((item) => item.id !== target.id) ?? null);
      setChats((current) => current?.filter((item) => item.project_id !== target.id) ?? null);
      if (projectId === target.id) void navigate("/");
      await deleteProject(target.id);
    } else {
      const chat = chats?.find((item) => item.id === target.id);
      setChats((current) => current?.filter((item) => item.id !== target.id) ?? null);
      if (chatId === target.id) void navigate(chat?.project_id ? `/p/${chat.project_id}` : "/");
      await deleteChat(target.id);
    }
  }

  const context: LayoutContext = {
    projects,
    chats,
    askCreateProject: () => setCreating(true),
    askRename: setRenaming,
    askDelete: setDeleting,
  };

  const deletingChats = deleting?.kind === "project" ? chatsOf(deleting.id).length : 0;

  return (
    <DrawerContext value={{ open: drawerOpen, setOpen: setDrawerOpen }}>
      <div className="flex h-svh overflow-hidden bg-t-secondary">
        {drawerOpen && (
          <nav
            aria-label={t("sidebar.label")}
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
                  <IconMessageCirclePlus />
                </IconTile>
              }
              selected={pathname === "/"}
            >
              {tc("sections.newChat")}
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

            <div className="-mx-2 mt-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2">
              <SectionLabel
                action={
                  <LightIconButton
                    aria-label={tc("sections.newProject")}
                    tooltip={tc("sections.newProject")}
                    size="xs"
                    onClick={() => setCreating(true)}
                  >
                    <IconPlus size={14} />
                  </LightIconButton>
                }
              >
                {tc("sections.projects")}
              </SectionLabel>
              {projects === null &&
                Array.from({ length: 3 }, (_, index) => (
                  <div key={index} className="flex h-7 items-center gap-2 px-1">
                    <Skeleton width={14} height={14} borderRadius={3} />
                    <Skeleton
                      width={`${50 + ((index * 17) % 40)}%`}
                      height={10}
                    />
                  </div>
                ))}
              {projects?.length === 0 && (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="rounded-sm px-1 py-1 text-left text-t-text-tertiary outline-none hover:text-t-text focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t("sidebar.noProjects")}
                </button>
              )}
              {projects?.map((project) => {
                const target: Target = { kind: "project", id: project.id, name: project.name };
                const current = project.id === projectId;
                return (
                  <div key={project.id} className="flex flex-col gap-px">
                    <ListItem
                      render={<Link to={`/p/${project.id}`} />}
                      selected={current && !chatId}
                      startIcon={<NameTile name={project.name} />}
                      actionsVisibility="hover"
                      actions={
                        <RowActions
                          target={target}
                          onRename={setRenaming}
                          onDelete={setDeleting}
                          onNewChat={() => void navigate(`/p/${project.id}`)}
                        />
                      }
                    >
                      {project.name}
                    </ListItem>
                    {/* The open project shows a way to start a chat in it, then its chats. */}
                    {current && (
                      <div className="pl-[22px]">
                        <ListItem
                          render={<Link to={`/p/${project.id}`} />}
                          startIcon={<IconPlus size={14} className="text-t-text-tertiary" />}
                        >
                          <span className="text-t-text-tertiary">{t("sidebar.newChat")}</span>
                        </ListItem>
                      </div>
                    )}
                    {current &&
                      chatsOf(project.id).map((chat) => (
                        <div key={chat.id} className="pl-[22px]">
                          <ListItem
                            render={<Link to={chatPath(chat)} />}
                            selected={chat.id === chatId}
                            actionsVisibility="hover"
                            actions={
                              <RowActions
                                target={{ kind: "chat", id: chat.id, name: chat.title }}
                                onRename={setRenaming}
                                onDelete={setDeleting}
                              />
                            }
                          >
                            <span className="text-t-text-secondary">{chat.title}</span>
                          </ListItem>
                        </div>
                      ))}
                  </div>
                );
              })}

              <SectionLabel
                action={
                  <LightIconButton
                    aria-label={t("sidebar.newPlainChat")}
                    tooltip={t("sidebar.newPlainChat")}
                    size="xs"
                    onClick={() => void navigate("/")}
                  >
                    <IconPlus size={14} />
                  </LightIconButton>
                }
              >
                {tc("sections.chats")}
              </SectionLabel>
              {plainChats?.length === 0 && (
                <p className="px-1 py-1 text-t-text-tertiary">
                  {t("sidebar.noChats")}
                </p>
              )}
              {plainChats?.map((chat) => (
                <ListItem
                  key={chat.id}
                  render={<Link to={chatPath(chat)} />}
                  selected={chat.id === chatId}
                  startIcon={
                    <IconTile color="jade">
                      <IconMessageCircleFilled />
                    </IconTile>
                  }
                  actionsVisibility="hover"
                  actions={
                    <RowActions
                      target={{ kind: "chat", id: chat.id, name: chat.title }}
                      onRename={setRenaming}
                      onDelete={setDeleting}
                    />
                  }
                >
                  {chat.title}
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
        <Outlet context={context} />
      </div>

      <NameDialog
        open={creating}
        onOpenChange={setCreating}
        title={tp("create.title")}
        nameLabel={tp("create.name")}
        namePlaceholder={tp("create.namePlaceholder")}
        describe
        descriptionLabel={tp("create.description")}
        descriptionPlaceholder={tp("create.descriptionPlaceholder")}
        confirm={tp("create.confirm")}
        maxLength={PROJECT_NAME_LENGTH}
        onSubmit={async (fields) => {
          const id = await createProject(fields);
          await navigate(`/p/${id}`);
        }}
      />
      <NameDialog
        open={renaming !== null}
        onOpenChange={(next) => !next && setRenaming(null)}
        title={renaming?.kind === "project" ? tp("rename.projectTitle") : tp("rename.chatTitle")}
        nameLabel={tp("rename.name")}
        initialName={renaming?.name ?? ""}
        confirm={tp("rename.confirm")}
        maxLength={renaming?.kind === "project" ? PROJECT_NAME_LENGTH : 120}
        onSubmit={async ({ name: next }) => {
          if (renaming) await rename(renaming, next);
        }}
      />
      <AlertDialog.Root
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop />
          <AlertDialog.Viewport>
            <AlertDialog.Popup size="sm">
              <AlertDialog.Header>
                <AlertDialog.Title>{t("sidebar.deleteTitle", { title: deleting?.name ?? "" })}</AlertDialog.Title>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <AlertDialog.Description>
                  {deleting?.kind === "project"
                    ? t("sidebar.deleteProjectBody", { count: deletingChats })
                    : t("sidebar.deleteChatBody")}
                </AlertDialog.Description>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <AlertDialog.Close render={<Button variant="outline" />}>{tc("cancel")}</AlertDialog.Close>
                <AlertDialog.Close
                  render={<Button variant="solid" color="danger" />}
                  onClick={() => {
                    if (deleting) void remove(deleting);
                  }}
                >
                  {deleting?.kind === "project"
                    ? t("sidebar.deleteProjectConfirm")
                    : t("sidebar.deleteChatConfirm")}
                </AlertDialog.Close>
              </AlertDialog.Footer>
            </AlertDialog.Popup>
          </AlertDialog.Viewport>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      <CommandMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        projects={projects}
        chats={chats}
        onCreateProject={() => setCreating(true)}
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
