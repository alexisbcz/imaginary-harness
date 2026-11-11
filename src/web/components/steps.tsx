import {
  IconCheck,
  IconCodeSearch,
  IconEye,
  IconFileCode,
  IconFolder,
  IconListCheck,
  IconBox,
  IconClockArrow,
  IconPencil,
  IconTerminal,
  IconTrash,
  IconWarningOctogonFill,
} from "@pierre/icons";
import type { ComponentType, SVGProps } from "react";

import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import type { Step } from "@/lib/chat";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

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
        icon: IconFileCode,
        running: `Writing ${path}`,
        done: `Wrote ${path}`,
      };
    case "edit_file":
      return {
        icon: IconPencil,
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
    case "run_sql":
      return {
        icon: IconCodeSearch,
        running: "Changing the database",
        done: "Changed the database",
      };
    case "restore_version":
      return {
        icon: IconClockArrow,
        running: "Restoring a version",
        done: "Restored a version",
      };
    default:
      return { icon: IconCheck, running: step.tool, done: step.tool };
  }
}

function StepLine({ step }: { step: Step }) {
  const { icon: StepIcon, running, done } = describe(step);
  const status =
    step.status === "running"
      ? "running"
      : step.status === "error"
        ? "error"
        : undefined;
  return (
    <TraceLine status={status} title={step.summary}>
      <TraceIcon>
        {step.status === "error" ? <IconWarningOctogonFill /> : <StepIcon />}
      </TraceIcon>
      <TraceTitle className="truncate">
        {step.status === "running" ? `${running}…` : done}
      </TraceTitle>
      {step.status === "error" && step.summary && (
        <TraceDescription className="truncate">{step.summary}</TraceDescription>
      )}
    </TraceLine>
  );
}

/** What the agent did for an answer: the running step in full, the finished ones folded once there are many. */
export function Steps({ steps: all, live }: { steps: Step[]; live: boolean }) {
  // Only well-formed steps: a malformed one must not take the chat down.
  const steps = all.filter(
    (step): step is Step =>
      typeof step === "object" &&
      step !== null &&
      typeof step.tool === "string",
  );
  if (steps.length === 0) return null;
  const FOLD_AFTER = 4;
  if (live || steps.length <= FOLD_AFTER) {
    return (
      <Trace>
        {steps.map((step) => (
          <div key={step.id}>
            <StepLine step={step} />
          </div>
        ))}
      </Trace>
    );
  }
  const edited = new Set(
    steps
      .filter((step) =>
        ["write_file", "edit_file", "delete_file"].includes(step.tool),
      )
      .map((step) => arg(step, "path")),
  );
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <IconListCheck />
            </TraceIcon>
            <TraceTitle>
              {steps.length} steps
              {edited.size > 0 &&
                `, ${edited.size} file${edited.size === 1 ? "" : "s"} changed`}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {steps.map((step) => (
              <div key={step.id}>
                <StepLine step={step} />
              </div>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
