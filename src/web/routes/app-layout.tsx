import { useEffect, useState } from "react";
import {
  Link,
  Outlet,
  useNavigate,
  useParams,
  useRouteLoaderData,
} from "react-router";
import type { User } from "@supabase/supabase-js";
import { IconPencilSquircle, IconSignOut, IconTrash } from "@pierre/icons";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import type { Thread } from "@/lib/chat";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

/** The signed-in user's threads, newest first, kept current through Realtime. */
function useThreads() {
  const [threads, setThreads] = useState<Thread[] | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data } = await supabase
        .from("threads")
        .select("id, title, updated_at")
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

export function AppLayout() {
  const { user } = useRouteLoaderData("app") as { user: User };
  const { threadId } = useParams();
  const navigate = useNavigate();
  const [threads, setThreads] = useThreads();

  async function remove(id: string) {
    setThreads(
      (current) => current?.filter((thread) => thread.id !== id) ?? null,
    );
    if (id === threadId) void navigate("/");
    await supabase.from("threads").delete().eq("id", id);
  }

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/" />}
                className="font-medium"
              >
                <IconPencilSquircle />
                New chat
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Chats</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {threads === null &&
                  Array.from({ length: 4 }, (_, index) => (
                    <SidebarMenuItem key={index}>
                      <SidebarMenuSkeleton />
                    </SidebarMenuItem>
                  ))}
                {threads?.map((thread) => (
                  <SidebarMenuItem key={thread.id}>
                    <SidebarMenuButton
                      render={<Link to={`/t/${thread.id}`} />}
                      isActive={thread.id === threadId}
                    >
                      <span className="truncate">{thread.title}</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      aria-label="Delete chat"
                      onClick={() => void remove(thread.id)}
                    >
                      <IconTrash />
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => void supabase.auth.signOut()}
                tooltip="Sign out"
              >
                <IconSignOut />
                <span className="truncate">{user.email}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="h-svh overflow-hidden">
        <header className="flex h-12 shrink-0 items-center px-3">
          <SidebarTrigger />
        </header>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
