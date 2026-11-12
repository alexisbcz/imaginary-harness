// A post as Substack will show it: the ProseMirror document the editor's Markdown becomes, drawn node by node, so
// the preview is the document Substack receives and not a second reading of the Markdown.

import type { ReactNode } from "react";
import { IconLock, IconBrandYoutube, IconPuzzle } from "@tabler/icons-react";
import { BUTTON_URLS, type PMDoc, type PMNode } from "@/lib/newsletter";

const BUTTON_LABELS: Record<string, string> = {
  [BUTTON_URLS.subscribe]: "Subscribe",
  [BUTTON_URLS.share]: "Share",
  [BUTTON_URLS.comment]: "Leave a comment",
};

function Inline({ nodes }: { nodes?: PMNode[] }) {
  return (
    <>
      {(nodes ?? []).map((node, index) => {
        if (node.type !== "text") return <Inline key={index} nodes={node.content} />;
        let out: ReactNode = node.text;
        for (const mark of node.marks ?? []) {
          if (mark.type === "strong") out = <strong>{out}</strong>;
          else if (mark.type === "em") out = <em>{out}</em>;
          else if (mark.type === "strikethrough") out = <s>{out}</s>;
          else if (mark.type === "code")
            out = <code className="rounded bg-t-secondary px-1 py-0.5 font-mono text-[0.88em]">{out}</code>;
          else if (mark.type === "link")
            out = (
              <a href={String(mark.attrs?.href ?? "")} target="_blank" rel="noreferrer" className="text-[var(--nl-accent)] underline underline-offset-2">
                {out}
              </a>
            );
        }
        return <span key={index}>{out}</span>;
      })}
    </>
  );
}

function Block({ node }: { node: PMNode }) {
  switch (node.type) {
    case "paragraph":
      return (
        <p className="my-4 min-h-[1em]">
          <Inline nodes={node.content} />
        </p>
      );
    case "heading": {
      const level = Number(node.attrs?.level) || 2;
      const size = level <= 1 ? "text-[1.6em]" : level === 2 ? "text-[1.35em]" : level === 3 ? "text-[1.15em]" : "text-[1em]";
      return (
        <div role="heading" aria-level={level} className={`mt-8 mb-3 font-bold leading-tight ${size}`}>
          <Inline nodes={node.content} />
        </div>
      );
    }
    case "blockquote":
    case "pullquote":
      return (
        <blockquote className="my-5 border-l-[3px] border-[var(--nl-accent)] pl-4 text-t-text-secondary">
          {(node.content ?? []).map((child, i) => (
            <Block key={i} node={child} />
          ))}
        </blockquote>
      );
    case "bullet_list":
    case "ordered_list": {
      const List = node.type === "ordered_list" ? "ol" : "ul";
      return (
        <List
          className={`my-4 pl-6 ${List === "ol" ? "list-decimal" : "list-disc"}`}
          start={node.type === "ordered_list" ? Number(node.attrs?.start) || 1 : undefined}
        >
          {(node.content ?? []).map((item, i) => (
            <li key={i} className="my-1 [&>p]:my-0">
              {(item.content ?? []).map((child, j) => (
                <Block key={j} node={child} />
              ))}
            </li>
          ))}
        </List>
      );
    }
    case "code_block":
    case "highlighted_code_block":
      return (
        <pre className="my-5 overflow-x-auto rounded-md bg-t-secondary p-3 font-mono text-[0.85em] leading-relaxed">
          {(node.content ?? []).map((c) => c.text).join("")}
        </pre>
      );
    case "horizontal_rule":
      return <hr className="my-8 border-t-border" />;
    case "captionedImage": {
      const image = node.content?.find((c) => c.type === "image2" || c.type === "image");
      const caption = node.content?.find((c) => c.type === "caption");
      return (
        <figure className="my-6">
          {image?.attrs?.src ? (
            <img src={String(image.attrs.src)} alt={String(image.attrs.alt ?? "")} className="mx-auto max-h-[520px] rounded-sm" loading="lazy" />
          ) : null}
          {caption && (
            <figcaption className="mt-2 text-center text-[0.82em] text-t-text-tertiary">
              <Inline nodes={caption.content} />
            </figcaption>
          )}
        </figure>
      );
    }
    case "paywall":
      return (
        <div className="my-8 flex items-center gap-3 text-[12px] font-medium tracking-wide text-t-text-tertiary uppercase">
          <span className="h-px flex-1 bg-t-border" />
          <IconLock size={14} /> Paid subscribers only below
          <span className="h-px flex-1 bg-t-border" />
        </div>
      );
    case "button": {
      const url = String(node.attrs?.url ?? "");
      return (
        <div className="my-6 text-center">
          <span className="inline-block rounded-md bg-[var(--nl-accent)] px-5 py-2.5 font-sans text-[14px] font-semibold text-white">
            {String(node.attrs?.text ?? BUTTON_LABELS[url] ?? "Button")}
          </span>
          {!BUTTON_LABELS[url] && <div className="mt-1 truncate text-[11px] text-t-text-light">{url}</div>}
        </div>
      );
    }
    case "youtube2":
      return (
        <div className="my-6 overflow-hidden rounded-md border border-t-border">
          <img
            src={`https://img.youtube.com/vi/${String(node.attrs?.videoId ?? "")}/hqdefault.jpg`}
            alt="YouTube video"
            className="aspect-video w-full object-cover"
          />
          <div className="flex items-center gap-2 px-3 py-2 font-sans text-[12px] text-t-text-tertiary">
            <IconBrandYoutube size={14} /> YouTube · {String(node.attrs?.videoId ?? "")}
          </div>
        </div>
      );
    default:
      return (
        <div className="my-5 flex items-center gap-2 rounded-md border border-dashed border-t-border px-3 py-2 font-sans text-[12px] text-t-text-tertiary">
          <IconPuzzle size={14} /> A Substack block ({node.type}) kept as it is
        </div>
      );
  }
}

export function PostPreview({
  doc,
  title,
  subtitle,
  author,
  publication,
  coverImage,
}: {
  doc: PMDoc;
  title: string;
  subtitle: string;
  author?: string | null;
  publication?: string;
  coverImage?: string | null;
}) {
  return (
    <article
      className="mx-auto w-full max-w-[680px] px-6 py-8 font-serif text-[17px] leading-[1.65] text-t-text [--nl-accent:#FF6719]"
      style={{ fontFamily: "Georgia, 'Iowan Old Style', 'Times New Roman', serif" }}
    >
      {publication && <div className="mb-6 font-sans text-[12px] font-semibold tracking-wide text-t-text-tertiary uppercase">{publication}</div>}
      <h1 className="text-[2em] leading-tight font-bold">{title || <span className="text-t-text-light">Title</span>}</h1>
      {subtitle && <p className="mt-2 text-[1.15em] text-t-text-secondary">{subtitle}</p>}
      {author && <div className="mt-4 font-sans text-[13px] text-t-text-tertiary">{author}</div>}
      {coverImage && <img src={coverImage} alt="" className="mt-6 w-full rounded-sm" />}
      <div className="mt-6 border-t border-t-border-light pt-2">
        {doc.content.length === 0 ? (
          <p className="my-4 text-t-text-light">Nothing written yet.</p>
        ) : (
          doc.content.map((node, i) => <Block key={i} node={node} />)
        )}
      </div>
    </article>
  );
}
