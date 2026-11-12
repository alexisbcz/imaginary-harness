import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

export type WorkspaceFile = {
  path: string;
  contents: string;
  previous: string | null;
  updated_at: string;
};

/** A project's files, kept current through Realtime as the agent (or the user) changes them. */
export function useWorkspaceFiles(projectId: string) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);

  useEffect(() => {
    let active = true;
    setFiles([]);
    const load = async () => {
      const { data } = await supabase
        .from("files")
        .select("path, contents, previous, updated_at")
        .eq("project_id", projectId)
        .order("path");
      if (active && data) setFiles(data);
    };
    const channel = supabase
      .channel(`files:${projectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "files",
          filter: `project_id=eq.${projectId}`,
        },
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
  }, [projectId]);

  return files;
}
