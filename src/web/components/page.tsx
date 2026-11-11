import { createContext, useContext, type ReactNode } from "react";
import { LightIconButton } from "twenty-ui/components/input";
import { IconLayoutSidebarLeftExpand } from "twenty-ui/icon";
import { cn } from "cn";

/** Whether the navigation drawer is open, and how to open or close it. */
export const DrawerContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
}>({ open: true, setOpen: () => {} });

export const useDrawer = () => useContext(DrawerContext);

/**
 * A page of the app, laid out like Twenty's: a slim header on the drawer's background with the page's title and
 * actions, and the page's content on a bordered card below it.
 */
export function Page({
  title,
  icon,
  actions,
  children,
  bodyClassName,
}: {
  title: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}) {
  const drawer = useDrawer();
  return (
    <div
      className={cn(
        "flex h-svh min-w-0 flex-1 flex-col pr-2 pb-2",
        !drawer.open && "pl-2",
      )}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 pl-1">
        {!drawer.open && (
          <LightIconButton
            aria-label="Open the sidebar"
            tooltip="Open the sidebar"
            onClick={() => drawer.setOpen(true)}
          >
            <IconLayoutSidebarLeftExpand size={16} />
          </LightIconButton>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-t-text">
          {icon && (
            <span className="flex shrink-0 text-t-text-tertiary">{icon}</span>
          )}
          <span className="truncate font-medium">{title}</span>
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </header>
      <main
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-t-border bg-t-primary",
          bodyClassName,
        )}
      >
        {children}
      </main>
    </div>
  );
}
