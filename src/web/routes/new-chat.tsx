import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "react-i18next";

import { Chip } from "twenty-ui/primitives/data-display";
import { Skeleton } from "twenty-ui/primitives/feedback";
import { IconClock, IconSparkles, IconTextSize } from "twenty-ui/icon";

import { IconSquareRoundedPlusFilled } from "@tabler/icons-react";

import { Composer } from "@/components/composer";
import { IconTile, NameTile } from "@/components/icon-tile";
import { Page } from "@/components/page";
import { startThread, type Outgoing, type Thread } from "@/lib/chat";
import { dateLocale } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/client";

const SUGGESTIONS = ["habits", "roastery", "kanban", "finance", "recipes"] as const;

const RECENT = 6;

function useRecentProjects() {
  const [projects, setProjects] = useState<Thread[] | null>(null);
  useEffect(() => {
    let active = true;
    createClient()
      .from("threads")
      .select("id, title, updated_at")
      .eq("kind", "project")
      .order("updated_at", { ascending: false })
      .limit(RECENT)
      .then(({ data }) => active && setProjects(data ?? []));
    return () => {
      active = false;
    };
  }, []);
  return projects;
}

/** Home: describe an app to start a project, or go back to a recent one. */
export function NewChat() {
  const { t } = useTranslation("builder");
  const { t: tc } = useTranslation("common");
  const navigate = useNavigate();
  const projects = useRecentProjects();
  const [value, setValue] = useState("");

  async function start(message: Outgoing) {
    const id = await startThread(message);
    await navigate(`/t/${id}`);
  }

  return (
    <Page
      title={tc("sections.newProject")}
      icon={
        <IconTile color="pink">
          <IconSquareRoundedPlusFilled />
        </IconTile>
      }
    >
      <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pt-[12vh] pb-16">
        <div className="flex w-full max-w-[640px] flex-col">
          <div className="mb-6 flex flex-col gap-1.5">
            <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.01em] text-balance text-t-text">
              {t("newChat.title")}
            </h1>
            <p className="text-t-text-tertiary">
              {t("newChat.subtitle")}
            </p>
          </div>
          <Composer
            autoFocus
            placeholder={t("newChat.placeholder")}
            value={value}
            onValueChange={setValue}
            onSend={start}
          />
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

          {(projects === null || projects.length > 0) && (
            <section className="mt-14 flex flex-col">
              <h2 className="mb-2 text-[11px] font-semibold text-t-text-light">
                {t("newChat.recent")}
              </h2>
              <div className="overflow-hidden rounded-md border border-t-border">
                <div className="grid h-8 grid-cols-[1fr_9rem] items-center border-b border-t-border bg-t-secondary text-t-text-tertiary">
                  <span className="flex items-center gap-1 px-2">
                    <IconTextSize size={14} /> {t("newChat.name")}
                  </span>
                  <span className="flex items-center gap-1 border-l border-t-border px-2">
                    <IconClock size={14} /> {t("newChat.lastEdited")}
                  </span>
                </div>
                {projects === null
                  ? Array.from({ length: 3 }, (_, index) => (
                      <div
                        key={index}
                        className="flex h-8 items-center gap-2 border-b border-t-border-light px-2 last:border-b-0"
                      >
                        <Skeleton width={14} height={14} borderRadius={3} />
                        <Skeleton width={160 + index * 40} height={10} />
                      </div>
                    ))
                  : projects.map((project) => (
                      <Link
                        key={project.id}
                        to={`/t/${project.id}`}
                        className="grid h-8 grid-cols-[1fr_9rem] items-center border-b border-t-border-light outline-none last:border-b-0 hover:bg-t-hover focus-visible:bg-t-hover"
                      >
                        <span className="flex min-w-0 items-center gap-2 px-2">
                          <NameTile name={project.title} />
                          <span className="truncate text-t-text">
                            {project.title}
                          </span>
                        </span>
                        <span className="truncate px-2 text-t-text-tertiary tabular-nums">
                          {formatDistanceToNow(new Date(project.updated_at), {
                            addSuffix: true,
                            locale: dateLocale(),
                          })}
                        </span>
                      </Link>
                    ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </Page>
  );
}
