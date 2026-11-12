import { useState, type ComponentType } from "react";
import { cn } from "cn";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
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
  IconBulb,
  IconClockCancel,
  IconFilePlus,
  IconMessageCircle,
  IconNotes,
  IconPhotoUp,
  IconPlug,
  IconFileCheck,
} from "@tabler/icons-react";

import type { Step } from "@/lib/chat";

type Icon = ComponentType<{ size?: number; className?: string }>;

const arg = (step: Step, name: string) =>
  typeof step.args?.[name] === "string" ? (step.args[name] as string) : "";

/** How a step reads in the chat, while it runs and once it is done. */
function describe(step: Step, t: TFunction<"builder">): { icon: Icon; running: string; done: string } {
  const path = arg(step, "path");
  switch (step.tool) {
    case "list_files":
      return {
        icon: IconFolder,
        running: t("steps.listFiles.running"),
        done: t("steps.listFiles.done"),
      };
    case "read_file":
      return {
        icon: IconEye,
        running: t("steps.readFile.running", { path }),
        done: t("steps.readFile.done", { path }),
      };
    case "write_file":
      return {
        icon: IconFileText,
        running: t("steps.writeFile.running", { path }),
        done: t("steps.writeFile.done", { path }),
      };
    case "edit_file":
      return {
        icon: IconFilePencil,
        running: t("steps.editFile.running", { path }),
        done: t("steps.editFile.done", { path }),
      };
    case "delete_file":
      return {
        icon: IconTrash,
        running: t("steps.deleteFile.running", { path }),
        done: t("steps.deleteFile.done", { path }),
      };
    case "check_app":
      return {
        icon: IconListCheck,
        running: t("steps.checkApp.running"),
        done: t("steps.checkApp.done"),
      };
    case "add_dependencies": {
      if (!Array.isArray(step.args?.packages))
        return {
          icon: IconBox,
          running: t("steps.addDependencies.runningAny"),
          done: t("steps.addDependencies.doneAny"),
        };
      const packages = (step.args.packages as string[]).join(", ");
      return {
        icon: IconBox,
        running: t("steps.addDependencies.running", { packages }),
        done: t("steps.addDependencies.done", { packages }),
      };
    }
    case "run_command": {
      const command = arg(step, "command");
      return {
        icon: IconTerminal,
        running: t("steps.runCommand.running", { command }),
        done: t("steps.runCommand.done", { command }),
      };
    }
    case "enable_database":
      return {
        icon: IconDatabase,
        running: t("steps.enableDatabase.running"),
        done: t("steps.enableDatabase.done"),
      };
    case "run_sql":
      return {
        icon: IconDatabaseExport,
        running: t("steps.runSql.running"),
        done: t("steps.runSql.done"),
      };
    case "restore_version":
      return {
        icon: IconRestore,
        running: t("steps.restoreVersion.running"),
        done: t("steps.restoreVersion.done"),
      };
    case "social_overview":
      return { icon: IconChartBar, running: t("steps.socialOverview.running"), done: t("steps.socialOverview.done") };
    case "social_performance":
      return { icon: IconChartBar, running: t("steps.socialPerformance.running"), done: t("steps.socialPerformance.done") };
    case "list_social_posts":
      return { icon: IconCalendarEvent, running: t("steps.listSocialPosts.running"), done: t("steps.listSocialPosts.done") };
    case "draft_social_post": {
      const content = arg(step, "content").replace(/\s+/g, " ");
      const short = content.length > 48 ? `${content.slice(0, 48)}…` : content;
      return { icon: IconCalendarPlus, running: t("steps.draftSocialPost.running", { text: short }), done: t("steps.draftSocialPost.done", { text: short }) };
    }
    case "update_social_post":
      return { icon: IconPencil, running: t("steps.updateSocialPost.running"), done: t("steps.updateSocialPost.done") };
    case "schedule_social_post":
      return { icon: IconCalendarTime, running: t("steps.scheduleSocialPost.running"), done: t("steps.scheduleSocialPost.done") };
    case "delete_social_post":
      return { icon: IconTrash, running: t("steps.deleteSocialPost.running"), done: t("steps.deleteSocialPost.done") };
    case "update_brand_brief":
      return { icon: IconId, running: t("steps.updateBrandBrief.running"), done: t("steps.updateBrandBrief.done") };
    case "research_social_account": {
      const handle = arg(step, "handle");
      return { icon: IconEyeSearch, running: t("steps.researchSocialAccount.running", { handle }), done: t("steps.researchSocialAccount.done", { handle }) };
    }
    case "list_watchlist":
      return { icon: IconBinoculars, running: t("steps.listWatchlist.running"), done: t("steps.listWatchlist.done") };
    case "watch_social_account": {
      const handle = arg(step, "handle");
      return { icon: IconBinoculars, running: t("steps.watchSocialAccount.running", { handle }), done: t("steps.watchSocialAccount.done", { handle }) };
    }
    case "import_social_post":
      return { icon: IconCalendarPlus, running: t("steps.importSocialPost.running"), done: t("steps.importSocialPost.done") };
    case "read_website": {
      const url = arg(step, "url").replace(/^https?:\/\//, "");
      return { icon: IconWorldSearch, running: t("steps.readWebsite.running", { url }), done: t("steps.readWebsite.done", { url }) };
    }
    case "read_web_page": {
      const url = arg(step, "url").replace(/^https?:\/\//, "");
      return { icon: IconWorldSearch, running: t("steps.readWebPage.running", { url }), done: t("steps.readWebPage.done", { url }) };
    }
    case "web_research": {
      const asked = arg(step, "question").replace(/\s+/g, " ");
      const question = asked.length > 60 ? `${asked.slice(0, 60)}…` : asked;
      return { icon: IconWorldSearch, running: t("steps.webResearch.running", { question }), done: t("steps.webResearch.done", { question }) };
    }
    case "newsletter_overview":
      return { icon: IconChartBar, running: t("steps.newsletterOverview.running"), done: t("steps.newsletterOverview.done") };
    case "newsletter_performance":
      return { icon: IconChartBar, running: t("steps.newsletterPerformance.running"), done: t("steps.newsletterPerformance.done") };
    case "list_newsletter_posts":
      return { icon: IconFileText, running: t("steps.listNewsletterPosts.running"), done: t("steps.listNewsletterPosts.done") };
    case "read_newsletter_post": {
      const id = arg(step, "id");
      return { icon: IconEye, running: t("steps.readNewsletterPost.running", { id }), done: t("steps.readNewsletterPost.done", { id }) };
    }
    case "write_newsletter_draft": {
      const title = arg(step, "title");
      const short = title.length > 48 ? `${title.slice(0, 48)}…` : title;
      return { icon: IconFilePlus, running: t("steps.writeNewsletterDraft.running", { title: short }), done: t("steps.writeNewsletterDraft.done", { title: short }) };
    }
    case "update_newsletter_draft": {
      const id = arg(step, "id");
      return { icon: IconPencil, running: t("steps.updateNewsletterDraft.running", { id }), done: t("steps.updateNewsletterDraft.done", { id }) };
    }
    case "check_newsletter_post":
      return { icon: IconFileCheck, running: t("steps.checkNewsletterPost.running"), done: t("steps.checkNewsletterPost.done") };
    case "schedule_newsletter_post":
      return { icon: IconCalendarTime, running: t("steps.scheduleNewsletterPost.running"), done: t("steps.scheduleNewsletterPost.done") };
    case "unschedule_newsletter_post":
      return { icon: IconClockCancel, running: t("steps.unscheduleNewsletterPost.running"), done: t("steps.unscheduleNewsletterPost.done") };
    case "delete_newsletter_draft":
      return { icon: IconTrash, running: t("steps.deleteNewsletterDraft.running"), done: t("steps.deleteNewsletterDraft.done") };
    case "read_newsletter_comments":
      return { icon: IconMessageCircle, running: t("steps.readNewsletterComments.running"), done: t("steps.readNewsletterComments.done") };
    case "update_newsletter_brief":
      return { icon: IconId, running: t("steps.updateNewsletterBrief.running"), done: t("steps.updateNewsletterBrief.done") };
    case "list_newsletter_ideas":
      return { icon: IconBulb, running: t("steps.listNewsletterIdeas.running"), done: t("steps.listNewsletterIdeas.done") };
    case "save_newsletter_idea": {
      const title = arg(step, "title");
      return {
        icon: IconBulb,
        running: title ? t("steps.saveNewsletterIdea.running", { title }) : t("steps.saveNewsletterIdea.runningAny"),
        done: title ? t("steps.saveNewsletterIdea.done", { title }) : t("steps.saveNewsletterIdea.doneAny"),
      };
    }
    case "draft_substack_note":
      return { icon: IconNotes, running: t("steps.draftSubstackNote.running"), done: t("steps.draftSubstackNote.done") };
    case "schedule_substack_note":
      return { icon: IconCalendarTime, running: t("steps.scheduleSubstackNote.running"), done: t("steps.scheduleSubstackNote.done") };
    case "add_newsletter_image":
      return { icon: IconPhotoUp, running: t("steps.addNewsletterImage.running"), done: t("steps.addNewsletterImage.done") };
    case "substack_mcp_tools":
      return { icon: IconPlug, running: t("steps.substackMcpTools.running"), done: t("steps.substackMcpTools.done") };
    case "call_substack_mcp": {
      const tool = arg(step, "tool");
      return { icon: IconPlug, running: t("steps.callSubstackMcp.running", { tool }), done: t("steps.callSubstackMcp.done", { tool }) };
    }
    case "list_mail":
    case "search_mail":
    case "read_mail":
      return { icon: IconEye, running: t("steps.readMail.running"), done: t("steps.readMail.done") };
    default:
      return { icon: IconCheck, running: step.tool, done: step.tool };
  }
}

function StepLine({ step }: { step: Step }) {
  const { t } = useTranslation("builder");
  const { icon: StepIcon, running, done } = describe(step, t);
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
  const { t } = useTranslation("builder");
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
          {edited.size > 0
            ? t("steps.summaryWithFiles", { steps: steps.length, count: edited.size })
            : t("steps.summary", { count: steps.length })}
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
