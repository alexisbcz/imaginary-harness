import { useEffect, useState } from "react";

import i18n from "@/lib/i18n";
import { nameFrom, startChat, THREAD_COLUMNS, type Outgoing, type Thread } from "@/lib/chat";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

/** A project: a name, what it is, what the agent should follow in it, its chats, and the app they build. */
export type Project = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  published_slug: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

// i18n-ignore: database columns
const PROJECT_COLUMNS = "id, name, description, instructions, published_slug, published_at, created_at, updated_at";

export const PROJECT_NAME_LENGTH = 80;
export const DESCRIPTION_LENGTH = 2000;
export const INSTRUCTIONS_LENGTH = 8000;

/**
 * The signed-in user's projects and chats (not the copilots' threads), newest first, kept current through
 * Realtime. The layout holds the one copy every page reads.
 */
export function useLibrary() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [chats, setChats] = useState<Thread[] | null>(null);

  useEffect(() => {
    let active = true;
    const loadProjects = async () => {
      const { data } = await supabase
        .from("projects")
        .select(PROJECT_COLUMNS)
        .order("updated_at", { ascending: false });
      if (active && data) setProjects(data as Project[]);
    };
    const loadChats = async () => {
      const { data } = await supabase
        .from("threads")
        .select(THREAD_COLUMNS)
        .eq("kind", "chat")
        .order("updated_at", { ascending: false });
      if (active && data) setChats(data as Thread[]);
    };
    const channel = supabase
      .channel("library")
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, () => void loadProjects())
      .on("postgres_changes", { event: "*", schema: "public", table: "threads" }, () => void loadChats())
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void loadProjects();
          void loadChats();
        }
      });
    void loadProjects();
    void loadChats();
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, []);

  return { projects, setProjects, chats, setChats };
}

export async function createProject(fields: { name: string; description?: string }) {
  const id = crypto.randomUUID();
  const { error } = await supabase.from("projects").insert({
    id,
    name: fields.name.trim().slice(0, PROJECT_NAME_LENGTH) || i18n.t("common:sections.newProject"),
    description: (fields.description ?? "").trim().slice(0, DESCRIPTION_LENGTH),
  });
  if (error) throw error;
  return id;
}

/** Starts a project from a first message: named after it, with the message as its first chat. */
export async function startProject(message: Outgoing) {
  const id = await createProject({
    name: nameFrom(message.content, i18n.t("common:sections.newProject"), 48),
  });
  return startChat(message, id);
}

export async function updateProject(
  id: string,
  fields: Partial<Pick<Project, "name" | "description" | "instructions">>,
) {
  const { error } = await supabase.from("projects").update(fields).eq("id", id);
  if (error) throw error;
}

export async function deleteProject(id: string) {
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) throw error;
}
