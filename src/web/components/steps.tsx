import { useState, type ComponentType } from "react";
import { cn } from "cn";
import {
  IconAlertTriangle,
  IconBox,
  IconChevronDown,
  IconCheck,
  IconDatabase,
  IconDatabaseExport,
  IconEye,
  IconFilePencil,
  IconFileText,
  IconFolder,
  IconListCheck,
  IconPencil,
  IconRestore,
  IconTerminal,
  IconTrash,
} from "twenty-ui/icon";

import {
  IconBinoculars,
  IconCalendarEvent,
  IconCalendarPlus,
  IconCalendarTime,
  IconChartBar,
  IconEyeSearch,
  IconId,
  IconWorldSearch,
} from "@tabler/icons-react";

import type { Step } from "@/lib/chat";

type Icon = ComponentType<{ size?: number; className?: string }>;

const arg = (step: Step, name: string) =>
  typeof step.args?.[name] === "string" ? (step.args[name] as string) : "";

/** How a step reads in the chat, while it runs and once it is done. */
function describe(step: Step): { icon: Icon; running: string; done: string } {
  const path = arg(step, "path");
  switch (step.tool) {
    case "list_files":
      return {
        icon: IconFolder,
        running: "Looking at the files",
        done: "Looked at the files",
      };
    case "read_file":
      return {
        icon: IconEye,
        running: `Reading ${path}`,
        done: `Read ${path}`,
      };
    case "write_file":
      return {
        icon: IconFileText,
        running: `Writing ${path}`,
        done: `Wrote ${path}`,
      };
    case "edit_file":
      return {
        icon: IconFilePencil,
        running: `Editing ${path}`,
        done: `Edited ${path}`,
      };
    case "delete_file":
      return {
        icon: IconTrash,
        running: `Deleting ${path}`,
        done: `Deleted ${path}`,
      };
    case "check_app":
      return {
        icon: IconListCheck,
        running: "Checking the app",
        done: "Checked the app",
      };
    case "add_dependencies": {
      const packages = Array.isArray(step.args?.packages)
        ? (step.args.packages as string[]).join(", ")
        : "packages";
      return {
        icon: IconBox,
        running: `Installing ${packages}`,
        done: `Installed ${packages}`,
      };
    }
    case "run_command": {
      const command = arg(step, "command");
      return {
        icon: IconTerminal,
        running: `Running ${command}`,
        done: `Ran ${command}`,
      };
    }
    case "enable_database":
      return {
        icon: IconDatabase,
        running: "Adding a database",
        done: "Added a database",
      };
    case "run_sql":
      return {
        icon: IconDatabaseExport,
        running: "Changing the database",
        done: "Changed the database",
      };
    case "restore_version":
      return {
        icon: IconRestore,
        running: "Restoring a version",
        done: "Restored a version",
      };
    case "social_overview":
      return { icon: IconChartBar, running: "Looking at the accounts and the calendar", done: "Looked at the accounts and the calendar" };
    case "social_performance":
      return { icon: IconChartBar, running: "Reading what worked", done: "Read what worked" };
    case "list_social_posts":
      return { icon: IconCalendarEvent, running: "Reading the calendar", done: "Read the calendar" };
    case "draft_social_post": {
      const content = arg(step, "content").replace(/\s+/g, " ");
      const short = content.length > 48 ? `${content.slice(0, 48)}…` : content;
      return { icon: IconCalendarPlus, running: `Drafting “${short}”`, done: `Drafted “${short}”` };
    }
    case "update_social_post":
      return { icon: IconPencil, running: "Editing a post", done: "Edited a post" };
    case "schedule_social_post":
      return { icon: IconCalendarTime, running: "Scheduling a post", done: "Scheduled a post" };
    case "delete_social_post":
      return { icon: IconTrash, running: "Deleting a post", done: "Deleted a post" };
    case "update_brand_brief":
      return { icon: IconId, running: "Updating the brand brief", done: "Updated the brand brief" };
    case "research_social_account": {
      const handle = arg(step, "handle");
      return { icon: IconEyeSearch, running: `Looking at ${handle}`, done: `Looked at ${handle}` };
    }
    case "list_watchlist":
      return { icon: IconBinoculars, running: "Reading the watchlist", done: "Read the watchlist" };
    case "watch_social_account": {
      const handle = arg(step, "handle");
      return { icon: IconBinoculars, running: `Adding ${handle} to the watchlist`, done: `Added ${handle} to the watchlist` };
    }
    case "import_social_post":
      return { icon: IconCalendarPlus, running: "Importing a published post", done: "Imported a published post" };
    case "read_website": {
      const url = arg(step, "url").replace(/^https?:\/\//, "");
      return { icon: IconWorldSearch, running: `Reading ${url}`, done: `Read ${url}` };
    }
    case "list_mail":
    case "search_mail":
    case "read_mail":
      return { icon: IconEye, running: "Reading mail", done: "Read mail" };
    default:
      return { icon: IconCheck, running: step.tool, done: step.tool };
  }
}

function StepLine({ step }: { step: Step }) {
  const { icon: StepIcon, running, done } = describe(step);
  const isRunning = step.status === "running";
  const failed = step.status === "error";
  return (
    <div
      title={step.summary}
      className={cn(
        "flex h-6 min-w-0 items-center gap-2 text-t-text-tertiary",
        failed && "text-t-text-danger",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {failed ? <IconAlertTriangle size={14} /> : <StepIcon size={14} />}
      </span>
      <span
        className={cn(
          "min-w-0 truncate",
          isRunning &&
            "shimmer text-t-text-secondary motion-reduce:shimmer-none",
        )}
      >
        {isRunning ? `${running}…` : done}
      </span>
      {failed && step.summary && (
        <span className="min-w-0 truncate text-t-text-light">
          {step.summary}
        </span>
      )}
    </div>
  );
}

/** What the agent did for an answer: the running step in full, the finished ones folded once there are many. */
export function Steps({ steps: all, live }: { steps: Step[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  // Only well-formed steps: a malformed one must not take the chat down.
  const steps = all.filter(
    (step): step is Step =>
      typeof step === "object" &&
      step !== null &&
      typeof step.tool === "string",
  );
  if (steps.length === 0) return null;
  const FOLD_AFTER = 4;
  const lines = (
    <div className="flex flex-col">
      {steps.map((step) => (
        <StepLine key={step.id} step={step} />
      ))}
    </div>
  );
  if (live || steps.length <= FOLD_AFTER) return lines;
  const edited = new Set(
    steps
      .filter((step) =>
        ["write_file", "edit_file", "delete_file"].includes(step.tool),
      )
      .map((step) => arg(step, "path")),
  );
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="-mx-1 flex h-6 w-fit items-center gap-2 rounded-sm px-1 text-t-text-tertiary outline-none hover:bg-t-hover hover:text-t-text-secondary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <IconListCheck size={14} />
        <span>
          {steps.length} steps
          {edited.size > 0 &&
            ` · ${edited.size} file${edited.size === 1 ? "" : "s"} changed`}
        </span>
        <IconChevronDown
          size={14}
          className={cn(
            "transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="mt-0.5 ml-[7px] border-l border-t-border pl-[11px]">
          {lines}
        </div>
      )}
    </div>
  );
}
