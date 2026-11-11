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
export function useWorkspaceFiles(threadId: string) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);

  useEffect(() => {
    let active = true;
    setFiles([]);
    const load = async () => {
      const { data } = await supabase
        .from("files")
        .select("path, contents, previous, updated_at")
        .eq("thread_id", threadId)
        .order("path");
      if (active && data) setFiles(data);
    };
    const channel = supabase
      .channel(`files:${threadId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "files",
          filter: `thread_id=eq.${threadId}`,
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
  }, [threadId]);

  return files;
}
