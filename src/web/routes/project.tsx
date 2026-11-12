import { useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "react-i18next";
import { LightIconButton } from "twenty-ui/components/input";
import { Skeleton } from "twenty-ui/primitives/feedback";
import { Textarea } from "twenty-ui/primitives/input";
import {
  IconClock,
  IconExternalLink,
  IconPencil,
  IconTextSize,
  IconTrash,
} from "twenty-ui/icon";
import { IconLayoutFilled, IconMessageCircleFilled } from "@tabler/icons-react";

import { Composer } from "@/components/composer";
import { EditableName } from "@/components/editable-name";
import { IconTile, NameTile } from "@/components/icon-tile";
import { Page } from "@/components/page";
import { api } from "@/lib/api";
import { chatPath, startChat, type Thread } from "@/lib/chat";
import { dateLocale } from "@/lib/i18n";
import {
  DESCRIPTION_LENGTH,
  INSTRUCTIONS_LENGTH,
  PROJECT_NAME_LENGTH,
  updateProject,
  type Project,
} from "@/lib/projects";
import type { LayoutContext } from "@/routes/app-layout";

/** A text of the project saved when the field is left, with a word of how it went. */
function ProjectText({
  project,
  field,
  maxLength,
  rows,
  label,
  placeholder,
  hint,
}: {
  project: Project;
  field: "description" | "instructions";
  maxLength: number;
  rows: number;
  label: string;
  placeholder: string;
  hint?: string;
}) {
  const { t } = useTranslation("common");
  const saved = project[field];
  const [draft, setDraft] = useState(saved);
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  // Another tab (or the agent) may change it: follow the saved text while the field is not being edited.
  useEffect(() => {
    if (!focused) setDraft(saved);
  }, [saved, focused]);

  async function save() {
    setFocused(false);
    if (draft === saved) return;
    setState("saving");
    try {
      await updateProject(project.id, { [field]: draft });
      setState("saved");
      setTimeout(() => setState((current) => (current === "saved" ? "idle" : current)), 1500);
    } catch {
      setState("failed");
    }
  }

  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-t-text-light">{label}</span>
        <span className="text-[11px] text-t-text-light" aria-live="polite">
          {state === "saving" ? t("saving") : state === "saved" ? t("saved") : state === "failed" ? t("saveFailed") : ""}
        </span>
      </span>
      <Textarea
        rows={rows}
        value={draft}
        maxLength={maxLength}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void save()}
      />
      {hint && <span className="text-[12px] leading-[1.45] text-t-text-tertiary">{hint}</span>}
    </label>
  );
}

/** Where the project's app is published, from the server, which knows the sites' origin. */
function PublishedLink({ projectId, slug }: { projectId: string; slug: string }) {
  const { t } = useTranslation("projects");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    api<{ url: string | null }>(`/api/projects/${projectId}/publish`)
      .then((result) => active && setUrl(result.url))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [projectId, slug]);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1 text-t-text-secondary underline-offset-2 hover:text-t-text hover:underline"
    >
      {t("project.published")} <IconExternalLink size={12} />
    </a>
  );
}

function ChatRow({
  chat,
  onRename,
  onDelete,
}: {
  chat: Thread;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("projects");
  return (
    <div className="group grid h-9 grid-cols-[1fr_9rem_auto] items-center border-b border-t-border-light last:border-b-0 hover:bg-t-hover">
      <Link
        to={chatPath(chat)}
        className="flex h-full min-w-0 items-center gap-2 px-2 outline-none focus-visible:bg-t-hover"
      >
        <IconTile size="sm" color="jade">
          <IconMessageCircleFilled />
        </IconTile>
        <span className="truncate text-t-text">{chat.title}</span>
      </Link>
      <span className="truncate px-2 text-t-text-tertiary tabular-nums">
        {formatDistanceToNow(new Date(chat.updated_at), { addSuffix: true, locale: dateLocale() })}
      </span>
      <span className="flex items-center gap-0.5 pr-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <LightIconButton aria-label={t("chat.renameNamed", { title: chat.title })} size="xs" onClick={onRename}>
          <IconPencil size={14} />
        </LightIconButton>
        <LightIconButton aria-label={t("chat.deleteNamed", { title: chat.title })} size="xs" onClick={onDelete}>
          <IconTrash size={14} />
        </LightIconButton>
      </span>
    </div>
  );
}

/** A project: its name, what it is, the instructions the agent follows in it, its chats, and its app. */
export function ProjectPage() {
  const { t } = useTranslation("projects");
  const { projectId } = useParams() as { projectId: string };
  const navigate = useNavigate();
  const { projects, chats, askDelete, askRename } = useOutletContext<LayoutContext>();
  const project = projects?.find((item) => item.id === projectId);
  const projectChats = chats?.filter((chat) => chat.project_id === projectId) ?? null;

  if (projects !== null && !project)
    return (
      <Page title={t("project.missingTitle")}>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="font-medium text-t-text">{t("project.missingTitle")}</p>
          <p className="text-t-text-tertiary">{t("project.missingBody")}</p>
          <Link to="/" className="text-t-text-secondary underline underline-offset-2 hover:text-t-text">
            {t("project.missingBack")}
          </Link>
        </div>
      </Page>
    );

  const rename = (name: string) => updateProject(projectId, { name });
  const latest = projectChats?.[0];

  return (
    <Page
      title={
        project ? (
          <EditableName
            value={project.name}
            label={t("project.rename")}
            maxLength={PROJECT_NAME_LENGTH}
            onRename={rename}
            className="font-medium text-t-text"
            inputClassName="w-full max-w-[360px] font-medium"
          />
        ) : (
          ""
        )
      }
      icon={project && <NameTile name={project.name} />}
      actions={
        project && (
          <LightIconButton
            aria-label={t("project.delete")}
            tooltip={t("project.delete")}
            size="sm"
            onClick={() => askDelete({ kind: "project", id: project.id, name: project.name })}
          >
            <IconTrash size={16} />
          </LightIconButton>
        )
      }
    >
      <div className="flex flex-1 flex-col overflow-y-auto px-4 pt-[8vh] pb-16">
        <div className="mx-auto flex w-full max-w-[880px] flex-col">
          {!project ? (
            <div className="flex flex-col gap-3">
              <Skeleton width={44} height={44} borderRadius={11} />
              <Skeleton width={240} height={18} />
              <Skeleton width="60%" height={12} />
            </div>
          ) : (
            <>
              <div className="mb-6 flex items-center gap-3">
                <NameTile name={project.name} size="lg" />
                <EditableName
                  value={project.name}
                  label={t("project.rename")}
                  maxLength={PROJECT_NAME_LENGTH}
                  onRename={rename}
                  className="text-[24px] leading-tight font-semibold tracking-[-0.01em] text-t-text"
                  inputClassName="w-full text-[24px] leading-tight font-semibold tracking-[-0.01em]"
                />
              </div>

              <Composer
                autoFocus
                placeholder={t("project.composerPlaceholder", { name: project.name })}
                onSend={async (message) => {
                  await navigate(await startChat(message, projectId));
                }}
              />

              <div className="mt-10 grid gap-8 md:grid-cols-[minmax(0,1fr)_280px]">
                <section className="flex min-w-0 flex-col">
                  <h2 className="mb-2 text-[11px] font-semibold text-t-text-light">{t("project.chats")}</h2>
                  {projectChats === null ? (
                    <div className="flex flex-col gap-2">
                      {Array.from({ length: 3 }, (_, index) => (
                        <Skeleton key={index} width={180 + index * 40} height={10} />
                      ))}
                    </div>
                  ) : projectChats.length === 0 ? (
                    <p className="rounded-md border border-dashed border-t-border px-3 py-6 text-center text-t-text-tertiary">
                      {t("project.noChats")}
                    </p>
                  ) : (
                    <div className="overflow-hidden rounded-md border border-t-border">
                      <div className="grid h-8 grid-cols-[1fr_9rem_auto] items-center border-b border-t-border bg-t-secondary text-t-text-tertiary">
                        <span className="flex items-center gap-1 px-2">
                          <IconTextSize size={14} /> {t("project.chatName")}
                        </span>
                        <span className="flex items-center gap-1 border-l border-t-border px-2">
                          <IconClock size={14} /> {t("project.lastMessage")}
                        </span>
                        <span className="w-[52px]" />
                      </div>
                      {projectChats.map((chat) => (
                        <ChatRow
                          key={chat.id}
                          chat={chat}
                          onRename={() => askRename({ kind: "chat", id: chat.id, name: chat.title })}
                          onDelete={() => askDelete({ kind: "chat", id: chat.id, name: chat.title })}
                        />
                      ))}
                    </div>
                  )}
                </section>

                <aside className="flex flex-col gap-6">
                  <section className="flex flex-col gap-2">
                    <h2 className="text-[11px] font-semibold text-t-text-light">{t("project.app")}</h2>
                    <div className="flex flex-col gap-2 rounded-md border border-t-border p-3">
                      <div className="flex items-center gap-2">
                        <IconTile color="blue">
                          <IconLayoutFilled />
                        </IconTile>
                        <span className="text-t-text-secondary">
                          {latest ? t("project.appBody") : t("project.appEmpty")}
                        </span>
                      </div>
                      {latest && (
                        <Link
                          to={chatPath(latest)}
                          className="text-t-text underline-offset-2 hover:underline"
                        >
                          {t("project.openApp")}
                        </Link>
                      )}
                      {project.published_slug && (
                        <PublishedLink projectId={project.id} slug={project.published_slug} />
                      )}
                    </div>
                  </section>
                  <ProjectText
                    project={project}
                    field="description"
                    maxLength={DESCRIPTION_LENGTH}
                    rows={3}
                    label={t("project.description")}
                    placeholder={t("project.descriptionPlaceholder")}
                  />
                  <ProjectText
                    project={project}
                    field="instructions"
                    maxLength={INSTRUCTIONS_LENGTH}
                    rows={6}
                    label={t("project.instructions")}
                    placeholder={t("project.instructionsPlaceholder")}
                    hint={t("project.instructionsHint")}
                  />
                </aside>
              </div>
            </>
          )}
        </div>
      </div>
    </Page>
  );
}
