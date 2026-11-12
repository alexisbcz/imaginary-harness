import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import {
  IconDeviceDesktopFilled,
  IconLanguage,
  IconLayoutSidebarLeftCollapseFilled,
  IconLayoutSidebarLeftExpandFilled,
  IconMoonFilled,
  IconPaletteFilled,
  IconNews,
  IconSpeakerphone,
  IconSquareRoundedPlusFilled,
  IconSunFilled,
} from "@tabler/icons-react";
import { Chip } from "twenty-ui/primitives/data-display";
import { Autocomplete } from "twenty-ui/primitives/input";
import { Dialog } from "twenty-ui/primitives/surfaces";
import { Shortcut } from "twenty-ui/primitives/typography";
import {
  IconArrowLeft,
  IconCheck,
  IconChevronRight,
  IconLogout,
  IconSearch,
} from "twenty-ui/icon";

import type { ThemeColor } from "twenty-ui/theme";

import { IconTile, NameTile } from "@/components/icon-tile";
import { useDrawer } from "@/components/page";
import {
  setThemePreference,
  useThemePreference,
  type ThemePreference,
} from "@/hooks/use-color-scheme";
import type { Thread } from "@/lib/chat";
import { currentLanguage, setLanguage } from "@/lib/i18n";
import { LANGUAGES } from "@/locales";
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
  /** The icon stands on its own, such as a project's avatar, instead of on a tile. */
  bare?: boolean;
  /** The tile's color: the same one the thing has elsewhere in the app. */
  color?: ThemeColor;
  description?: ReactNode;
  end?: ReactNode;
  run: () => void;
};

type Group = { value: string; label: string; items: Command[] };

type View = "root" | "theme" | "language";

const themes: {
  value: ThemePreference;
  icon: ReactNode;
  color: ThemeColor;
}[] = [
  { value: "system", icon: <IconDeviceDesktopFilled />, color: "gray" },
  { value: "light", icon: <IconSunFilled />, color: "orange" },
  { value: "dark", icon: <IconMoonFilled />, color: "iris" },
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
  const { t, i18n } = useTranslation("layout");
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
    if (view === "language") {
      return [
        {
          value: "language",
          label: t("commands.language"),
          items: LANGUAGES.map((language) => ({
            value: `language-${language.code}`,
            label: language.label,
            icon: <IconLanguage />,
            color: "blue" as ThemeColor,
            end: language.code === currentLanguage() && <IconCheck size={16} />,
            run: close(() => setLanguage(language.code)),
          })),
        },
      ];
    }
    if (view === "theme") {
      return [
        {
          value: "theme",
          label: t("commands.theme"),
          items: themes.map((option) => ({
            value: `theme-${option.value}`,
            label: t(`commands.themes.${option.value}`),
            icon: option.icon,
            color: option.color,
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
        label: t("commands.actions"),
        items: [
          {
            value: "new-project",
            label: t("commands.newProject"),
            keywords: t("commands.newProjectKeywords"),
            icon: <IconSquareRoundedPlusFilled />,
            color: "pink",
            run: close(() => void navigate("/")),
          },
          {
            value: "social",
            label: t("commands.social"),
            keywords: t("commands.socialKeywords"),
            icon: <IconSpeakerphone />,
            color: "violet",
            run: close(() => void navigate("/social")),
          },
          {
            value: "newsletter",
            label: t("commands.newsletter"),
            keywords: t("commands.newsletterKeywords"),
            icon: <IconNews />,
            color: "orange",
            run: close(() => void navigate("/newsletter")),
          },
          {
            value: "sidebar",
            label: drawer.open ? t("commands.hideSidebar") : t("commands.showSidebar"),
            keywords: t("commands.sidebarKeywords"),
            icon: drawer.open ? (
              <IconLayoutSidebarLeftCollapseFilled />
            ) : (
              <IconLayoutSidebarLeftExpandFilled />
            ),
            run: close(() => drawer.setOpen(!drawer.open)),
          },
        ],
      },
      {
        value: "projects",
        label: t("commands.projects"),
        items: (threads ?? [])
          .filter((thread) => thread.id !== threadId)
          .map((thread) => ({
            value: `project-${thread.id}`,
            label: thread.title,
            keywords: t("commands.projectKeywords"),
            icon: <NameTile name={thread.title} />,
            bare: true,
            run: close(() => void navigate(`/t/${thread.id}`)),
          })),
      },
      {
        value: "settings",
        label: t("commands.settings"),
        items: [
          {
            value: "theme",
            label: t("commands.changeTheme"),
            keywords: t("commands.themeKeywords"),
            icon: <IconPaletteFilled />,
            color: "plum",
            description: t(`commands.themes.${currentTheme.value}`),
            end: <IconChevronRight size={16} />,
            run: () => go("theme"),
          },
          {
            value: "language",
            label: t("commands.changeLanguage"),
            keywords: t("commands.languageKeywords"),
            icon: <IconLanguage />,
            color: "blue",
            description: LANGUAGES.find((l) => l.code === i18n.resolvedLanguage)?.label,
            end: <IconChevronRight size={16} />,
            run: () => go("language"),
          },
          {
            value: "sign-out",
            label: t("commands.signOut"),
            keywords: t("commands.signOutKeywords"),
            icon: <IconLogout />,
            color: "tomato",
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
            <Dialog.Title className="sr-only">{t("commands.title")}</Dialog.Title>
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
                    aria-label={t("commands.back")}
                    startElement={<IconArrowLeft size={12} />}
                    onClick={() => go("root")}
                  >
                    {view === "theme" ? t("commands.theme") : t("commands.language")}
                  </Chip>
                )}
                <Autocomplete.Input
                  ref={inputRef}
                  aria-label={t("commands.searchLabel")}
                  placeholder={
                    view === "root"
                      ? t("commands.searchPlaceholder")
                      : view === "theme"
                        ? t("commands.searchThemes")
                        : t("commands.searchLanguages")
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
                          startIcon={
                            item.bare ? (
                              item.icon
                            ) : (
                              <IconTile color={item.color}>
                                {item.icon}
                              </IconTile>
                            )
                          }
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
                {t("commands.nothing", { query: query.trim() })}
              </Autocomplete.Empty>

              <div className="hidden h-10 shrink-0 items-center gap-4 border-t border-t-border-light px-4 text-[12px] text-t-text-tertiary md:flex">
                <span className="flex items-center gap-1.5">
                  <Shortcut shortcut={["↑"]} />
                  <Shortcut shortcut={["↓"]} />
                  {t("commands.move")}
                </span>
                <span className="flex items-center gap-1.5">
                  <Shortcut shortcut={["Enter"]} />
                  {t("commands.select")}
                </span>
                {view !== "root" && (
                  <span className="flex items-center gap-1.5">
                    <Shortcut shortcut={["⌫"]} />
                    {t("commands.goBack")}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1.5">
                  <Shortcut shortcut={["Mod", "K"]} />
                  {t("commands.toggle")}
                </span>
              </div>
            </Autocomplete.Root>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
