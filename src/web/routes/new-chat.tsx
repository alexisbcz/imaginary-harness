import { useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "react-i18next";

import { SegmentedControl } from "twenty-ui/components/input";
import { Chip } from "twenty-ui/primitives/data-display";
import { Skeleton } from "twenty-ui/primitives/feedback";
import { IconSparkles } from "twenty-ui/icon";

import { IconMessageCirclePlus } from "@tabler/icons-react";

import { Composer } from "@/components/composer";
import { IconTile, NameTile } from "@/components/icon-tile";
import { Page } from "@/components/page";
import { startChat, type Outgoing } from "@/lib/chat";
import { dateLocale } from "@/lib/i18n";
import { startProject } from "@/lib/projects";
import type { LayoutContext } from "@/routes/app-layout";

const SUGGESTIONS = ["habits", "roastery", "kanban", "finance", "recipes"] as const;

const RECENT = 6;

type Start = "chat" | "project";

/** Home: start a chat, or describe an app to start a project; and go back to a recent project. */
export function NewChat() {
  const { t } = useTranslation("builder");
  const { t: tp } = useTranslation("projects");
  const { t: tc } = useTranslation("common");
  const navigate = useNavigate();
  const { projects, askCreateProject } = useOutletContext<LayoutContext>();
  const [value, setValue] = useState("");
  const [start, setStart] = useState<Start>("chat");

  async function send(message: Outgoing) {
    await navigate(
      start === "project" ? await startProject(message) : await startChat(message),
    );
  }

  const recent = projects?.slice(0, RECENT) ?? null;

  return (
    <Page
      title={tc("sections.newChat")}
      icon={
        <IconTile color="pink">
          <IconMessageCirclePlus />
        </IconTile>
      }
    >
      <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pt-[12vh] pb-16">
        <div className="flex w-full max-w-[640px] flex-col">
          <div className="mb-6 flex flex-col gap-1.5">
            <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.01em] text-balance text-t-text">
              {start === "project" ? t("newChat.title") : tp("home.title")}
            </h1>
            <p className="text-t-text-tertiary">
              {start === "project" ? t("newChat.subtitle") : tp("home.subtitle")}
            </p>
          </div>
          <div className="mb-2 flex">
            <SegmentedControl<Start>
              aria-label={tp("home.startLabel")}
              size="sm"
              value={start}
              onValueChange={setStart}
              options={[
                { value: "chat", label: tp("home.startChat") },
                { value: "project", label: tp("home.startProject") },
              ]}
            />
          </div>
          <Composer
            autoFocus
            modes={start === "project"}
            placeholder={start === "project" ? t("newChat.placeholder") : tp("home.placeholder")}
            value={value}
            onValueChange={setValue}
            onSend={send}
          />
          {start === "project" && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((key) => t(`newChat.suggestions.${key}`)).map((suggestion) => (
                <Chip
                  key={suggestion}
                  variant="outline"
                  shape="round"
                  size="md"
                  color="secondary"
                  className="[&>span]:leading-[16px]"
                  startElement={<IconSparkles size={14} />}
                  onClick={() => setValue(suggestion)}
                  render={<button type="button" />}
                >
                  {suggestion}
                </Chip>
              ))}
            </div>
          )}

          <section className="mt-14 flex flex-col">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[11px] font-semibold text-t-text-light">{t("newChat.recent")}</h2>
              <button
                type="button"
                onClick={askCreateProject}
                className="rounded-sm px-1 text-[12px] text-t-text-tertiary outline-none hover:bg-t-hover hover:text-t-text focus-visible:ring-2 focus-visible:ring-ring"
              >
                {tp("home.newProject")}
              </button>
            </div>
            {recent?.length === 0 ? (
              <p className="rounded-md border border-dashed border-t-border px-3 py-6 text-center text-t-text-tertiary">
                {tp("home.noProjects")}
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {recent === null
                  ? Array.from({ length: 4 }, (_, index) => (
                      <div
                        key={index}
                        className="flex h-[60px] items-center gap-3 rounded-md border border-t-border px-3"
                      >
                        <Skeleton width={32} height={32} borderRadius={8} />
                        <div className="flex flex-col gap-1.5">
                          <Skeleton width={120 + index * 20} height={10} />
                          <Skeleton width={70} height={8} />
                        </div>
                      </div>
                    ))
                  : recent.map((project) => (
                      <Link
                        key={project.id}
                        to={`/p/${project.id}`}
                        className="flex h-[60px] min-w-0 items-center gap-3 rounded-md border border-t-border px-3 outline-none hover:bg-t-hover focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <NameTile name={project.name} size="md" />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium text-t-text">{project.name}</span>
                          <span className="truncate text-[12px] text-t-text-tertiary tabular-nums">
                            {project.description.trim() ||
                              formatDistanceToNow(new Date(project.updated_at), {
                                addSuffix: true,
                                locale: dateLocale(),
                              })}
                          </span>
                        </span>
                      </Link>
                    ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </Page>
  );
}
