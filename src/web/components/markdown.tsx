import {
  isValidElement,
  memo,
  type ComponentProps,
  type ReactElement,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { File, PatchDiff, type SupportedLanguages } from "@pierre/diffs/react";
import { cn } from "cn";

const CODE_OPTIONS = {
  themeType: "light",
  disableFileHeader: true,
  overflow: "scroll",
} as const;

/** A unified patch with file headers and hunks, which `PatchDiff` can parse; model-written diffs often lack them. */
const isPatch = (code: string) => /^--- .+\n\+\+\+ .+\n@@ /m.test(code);

/**
 * Rewrites each hunk header's line counts from the lines that follow it. Models often miscount them, and a patch
 * still streaming in has a last hunk shorter than its header says; `PatchDiff` needs the counts right.
 */
function fixHunkCounts(patch: string) {
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(
      lines[i]!,
    );
    if (header === null) continue;
    let removed = 0;
    let added = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (
        line.startsWith("@@") ||
        line.startsWith("diff ") ||
        (line.startsWith("--- ") && lines[j + 1]?.startsWith("+++ "))
      )
        break;
      if (line.startsWith("-")) removed++;
      else if (line.startsWith("+")) added++;
      else if (line.startsWith(" ") || line === "") {
        removed++;
        added++;
      }
    }
    lines[i] =
      `@@ -${header[1]},${removed} +${header[2]},${added} @@${header[3]}`;
  }
  return lines.join("\n");
}

/** A fenced code block, highlighted by Pierre's diffs: a patch as a diff, anything else as a file. */
function CodeBlock({
  code,
  language,
}: {
  code: string;
  language: string | undefined;
}) {
  const lang = (language ?? "text") as SupportedLanguages;
  return (
    <div className="my-3 overflow-hidden rounded-xl border text-[13px]">
      {(lang === "diff" || lang === ("patch" as SupportedLanguages)) &&
      isPatch(code) ? (
        <PatchDiff
          patch={fixHunkCounts(code)}
          options={{ ...CODE_OPTIONS, diffStyle: "unified" }}
        />
      ) : (
        <File
          file={{ name: `snippet.${lang}`, contents: code, lang }}
          options={CODE_OPTIONS}
        />
      )}
    </div>
  );
}

const components: Components = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    if (!isValidElement(child)) return <pre>{children}</pre>;
    const { className, children: code } = (
      child as ReactElement<ComponentProps<"code">>
    ).props;
    const language = /language-([\w+-]+)/.exec(className ?? "")?.[1];
    return (
      <CodeBlock
        code={String(code ?? "").replace(/\n$/, "")}
        language={language}
      />
    );
  },
  code: ({ className, ...props }) => (
    <code
      className={cn(
        "rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.9em]",
        className,
      )}
      {...props}
    />
  ),
  p: (props) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  ul: (props) => <ul className="my-2 list-disc ps-6" {...props} />,
  ol: (props) => <ol className="my-2 list-decimal ps-6" {...props} />,
  li: (props) => <li className="my-1" {...props} />,
  a: (props) => (
    <a
      className="underline underline-offset-4"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  h1: (props) => (
    <h1 className="mt-5 mb-2 font-heading text-lg font-medium" {...props} />
  ),
  h2: (props) => (
    <h2 className="mt-5 mb-2 font-heading text-base font-medium" {...props} />
  ),
  h3: (props) => <h3 className="mt-4 mb-2 font-medium" {...props} />,
  blockquote: (props) => (
    <blockquote
      className="my-2 border-s-2 ps-3 text-muted-foreground"
      {...props}
    />
  ),
  table: (props) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-left" {...props} />
    </div>
  ),
  th: (props) => <th className="border-b px-2 py-1 font-medium" {...props} />,
  td: (props) => <td className="border-b px-2 py-1" {...props} />,
};

/** An assistant answer: GitHub-flavored Markdown, code through Pierre's diffs. */
export const Markdown = memo(function Markdown({
  children,
}: {
  children: string;
}) {
  return (
    <div className="min-w-0 leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
