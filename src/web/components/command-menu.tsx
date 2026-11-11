import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { Avatar, Chip } from "twenty-ui/primitives/data-display";
import { Autocomplete } from "twenty-ui/primitives/input";
import { Dialog } from "twenty-ui/primitives/surfaces";
import { Shortcut } from "twenty-ui/primitives/typography";
import {
  IconArrowLeft,
  IconCheck,
  IconChevronRight,
  IconColorSwatch,
  IconDeviceDesktop,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLogout,
  IconMoon,
  IconSearch,
  IconSquarePlus,
  IconSun,
} from "twenty-ui/icon";

import { useDrawer } from "@/components/page";
import {
  setThemePreference,
  useThemePreference,
  type ThemePreference,
} from "@/hooks/use-color-scheme";
import type { Thread } from "@/lib/chat";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

const isMac = /mac|iphone|ipad/i.test(
  (navigator as Navigator & { userAgentData?: { platform: string } })
    .userAgentData?.platform ?? navigator.platform,
);

/** Opens and closes the command menu on ⌘K on a Mac, Ctrl+K elsewhere. */
export function useCommandMenuShortcut(toggle: () => void) {
  const latest = useRef(toggle);
  latest.current = toggle;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

type Command = {
  value: string;
  label: string;
  /** Other words the command answers to when searching. */
  keywords?: string;
  icon: ReactNode;
  description?: ReactNode;
  end?: ReactNode;
  run: () => void;
};

type Group = { value: string; label: string; items: Command[] };

type View = "root" | "theme";

const themes: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  { value: "system", label: "System", icon: <IconDeviceDesktop size={16} /> },
  { value: "light", label: "Light", icon: <IconSun size={16} /> },
  { value: "dark", label: "Dark", icon: <IconMoon size={16} /> },
];

/** Projects shown before anything is typed; typing searches all of them. */
const RECENT_PROJECTS = 5;

/**
 * The command menu: search projects, start a new one, and change settings from anywhere in the app with the
 * keyboard.
 */
export function CommandMenu({
  open,
  onOpenChange,
  threads,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threads: Thread[] | null;
}) {
  const navigate = useNavigate();
  const { threadId } = useParams();
  const drawer = useDrawer();
  const theme = useThemePreference();
  const [view, setView] = useState<View>("root");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { contains } = Autocomplete.useFilter({ sensitivity: "base" });

  // Each opening starts on the first page with an empty search.
  useEffect(() => {
    if (!open) return;
    setView("root");
    setQuery("");
  }, [open]);

  function go(next: View) {
    setView(next);
    setQuery("");
    inputRef.current?.focus();
  }

  function close(run: () => void) {
    return () => {
      onOpenChange(false);
      run();
    };
  }

  const groups: Group[] = (() => {
    if (view === "theme") {
      return [
        {
          value: "theme",
          label: "Theme",
          items: themes.map((option) => ({
            value: `theme-${option.value}`,
            label: option.label,
            icon: option.icon,
            end: option.value === theme && <IconCheck size={16} />,
            run: close(() => setThemePreference(option.value)),
          })),
        },
      ];
    }

    const currentTheme = themes.find((option) => option.value === theme)!;
    return [
      {
        value: "actions",
        label: "Actions",
        items: [
          {
            value: "new-project",
            label: "New project",
            keywords: "create start app",
            icon: <IconSquarePlus size={16} />,
            run: close(() => void navigate("/")),
          },
          {
            value: "sidebar",
            label: drawer.open ? "Hide the sidebar" : "Show the sidebar",
            keywords: "toggle drawer navigation panel",
            icon: drawer.open ? (
              <IconLayoutSidebarLeftCollapse size={16} />
            ) : (
              <IconLayoutSidebarLeftExpand size={16} />
            ),
            run: close(() => drawer.setOpen(!drawer.open)),
          },
        ],
      },
      {
        value: "projects",
        label: "Projects",
        items: (threads ?? [])
          .filter((thread) => thread.id !== threadId)
          .map((thread) => ({
            value: `project-${thread.id}`,
            label: thread.title,
            keywords: "project open go",
            icon: <Avatar name={thread.title} size="sm" shape="rounded-square" />,
            run: close(() => void navigate(`/t/${thread.id}`)),
          })),
      },
      {
        value: "settings",
        label: "Settings",
        items: [
          {
            value: "theme",
            label: "Change theme",
            keywords: "appearance dark light mode color scheme",
            icon: <IconColorSwatch size={16} />,
            description: currentTheme.label,
            end: <IconChevronRight size={16} />,
            run: () => go("theme"),
          },
          {
            value: "sign-out",
            label: "Sign out",
            keywords: "log out logout account leave",
            icon: <IconLogout size={16} />,
            run: close(() => void supabase.auth.signOut()),
          },
        ],
      },
    ];
  })();

  const filtered = (() => {
    const search = query.trim();
    return groups
      .map((group) => {
        let items = search
          ? group.items.filter((item) =>
              contains(`${item.label} ${item.keywords ?? ""}`, search),
            )
          : group.items;
        if (!search && group.value === "projects") {
          items = items.slice(0, RECENT_PROJECTS);
        }
        return { ...group, items };
      })
      .filter((group) => group.items.length > 0);
  })();

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next, details) => {
        // Escape on a sub-page goes back to the first page instead of closing.
        if (!next && details.reason === "escape-key" && view !== "root") {
          details.cancel();
          go("root");
          return;
        }
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Viewport className="items-start pt-[min(14vh,120px)]">
          <Dialog.Popup
            initialFocus={inputRef}
            className="w-[600px] overflow-hidden"
          >
            <Dialog.Title className="sr-only">Command menu</Dialog.Title>
            <Autocomplete.Root
              inline
              open
              items={groups}
              filteredItems={filtered}
              value={query}
              onValueChange={(value, details) => {
                // Picking an item runs it; only typing changes the search.
                if (details.reason === "item-press") return;
                setQuery(value);
              }}
              autoHighlight="always"
              keepHighlight
            >
              <div className="flex h-12 shrink-0 items-center gap-2 border-b border-t-border-light px-4">
                {view === "root" ? (
                  <IconSearch
                    size={16}
                    className="shrink-0 text-t-text-tertiary"
                  />
                ) : (
                  <Chip
                    variant="soft"
                    clickable
                    aria-label="Back to all commands"
                    startElement={<IconArrowLeft size={12} />}
                    onClick={() => go("root")}
                  >
                    Theme
                  </Chip>
                )}
                <Autocomplete.Input
                  ref={inputRef}
                  aria-label="Search commands and projects"
                  placeholder={
                    view === "root"
                      ? "Search projects, actions and settings…"
                      : "Search themes…"
                  }
                  onKeyDown={(event) => {
                    // Backspace in an empty search goes back to the first page.
                    if (
                      event.key === "Backspace" &&
                      query === "" &&
                      view !== "root"
                    ) {
                      event.preventDefault();
                      go("root");
                    }
                  }}
                  render={
                    <input className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-t-text outline-none placeholder:text-t-text-light" />
                  }
                />
                <Shortcut
                  shortcut={["esc"]}
                  visibility="desktop"
                  className="text-[11px]"
                />
              </div>

              <Autocomplete.List className="max-h-[min(400px,55dvh)] scroll-py-2 px-2 pt-1 pb-2">
                {(group: Group) => (
                  <Autocomplete.Group
                    key={group.value}
                    items={group.items}
                    className="pt-1"
                  >
                    <Autocomplete.GroupLabel className="px-2 pt-2 pb-1 text-[11px] font-semibold text-t-text-light">
                      {group.label}
                    </Autocomplete.GroupLabel>
                    <Autocomplete.Collection>
                      {(item: Command) => (
                        <Autocomplete.Item
                          key={item.value}
                          value={item}
                          startIcon={item.icon}
                          description={item.description}
                          endIcon={item.end || undefined}
                          onClick={item.run}
                        >
                          {item.label}
                        </Autocomplete.Item>
                      )}
                    </Autocomplete.Collection>
                  </Autocomplete.Group>
                )}
              </Autocomplete.List>
              <Autocomplete.Empty className="px-4 py-8 text-center empty:hidden">
                Nothing matches “{query.trim()}”.
              </Autocomplete.Empty>

              <div className="hidden h-10 shrink-0 items-center gap-4 border-t border-t-border-light px-4 text-[12px] text-t-text-tertiary md:flex">
                <span className="flex items-center gap-1.5">
                  <Shortcut shortcut={["↑"]} />
                  <Shortcut shortcut={["↓"]} />
                  Move
                </span>
                <span className="flex items-center gap-1.5">
                  <Shortcut shortcut={["Enter"]} />
                  Select
                </span>
                {view !== "root" && (
                  <span className="flex items-center gap-1.5">
                    <Shortcut shortcut={["⌫"]} />
                    Back
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1.5">
                  <Shortcut shortcut={["Mod", "K"]} />
                  Toggle
                </span>
              </div>
            </Autocomplete.Root>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
