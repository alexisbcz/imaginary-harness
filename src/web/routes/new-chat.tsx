import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { formatDistanceToNow } from "date-fns";

import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Composer } from "@/components/composer";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { startThread, type Outgoing, type Thread } from "@/lib/chat";
import { createClient } from "@/lib/supabase/client";

const SUGGESTIONS = [
  "A habit tracker with streaks and a weekly chart",
  "A landing page for a coffee roastery",
  "A kanban board with drag and drop",
  "A personal finance dashboard",
  "A recipe book with search and tags",
];

const RECENT = 6;

function useRecentProjects() {
  const [projects, setProjects] = useState<Thread[] | null>(null);
  useEffect(() => {
    let active = true;
    createClient()
      .from("threads")
      .select("id, title, updated_at")
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
  const navigate = useNavigate();
  const projects = useRecentProjects();
  const [value, setValue] = useState("");

  async function start(message: Outgoing) {
    const id = await startThread(message);
    await navigate(`/t/${id}`);
  }

  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pt-[14vh] pb-16">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="font-heading text-3xl font-medium text-balance">
            What do you want to build?
          </h1>
          <p className="text-muted-foreground">
            Describe an app, or paste a screenshot of one. Richelieu builds it
            while you watch.
          </p>
        </div>
        <Composer
          autoFocus
          placeholder="An app that…"
          value={value}
          onValueChange={setValue}
          onSend={start}
        />
        <Suggestions className="justify-center">
          {SUGGESTIONS.map((suggestion) => (
            <Suggestion
              key={suggestion}
              suggestion={suggestion}
              onClick={(text) => setValue(text)}
            />
          ))}
        </Suggestions>

        {projects && projects.length > 0 && (
          <section className="mt-10 flex flex-col gap-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              Recent projects
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((project) => (
                <Link
                  key={project.id}
                  to={`/t/${project.id}`}
                  className="rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <Card className="h-full transition-colors hover:bg-muted/50">
                    <CardHeader>
                      <CardTitle className="line-clamp-2 text-sm">
                        {project.title}
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Edited{" "}
                        {formatDistanceToNow(new Date(project.updated_at), {
                          addSuffix: true,
                        })}
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
