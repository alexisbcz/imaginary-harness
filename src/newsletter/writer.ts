// The newsletter's brief as the model reads it, and the editor's one-shot assists: rewriting a selection, writing
// on from the cursor, turning an outline into a draft, proposing titles, reviewing a draft, writing a Note. They
// answer in seconds, beside the copilot's conversation, for writing together in the editor.

import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { config } from "../config.ts";
import type { Newsletter } from "./service.ts";

const AUDIENCE_LABELS: Record<string, string> = {
  everyone: "everyone",
  only_paid: "paid subscribers only",
  founding: "founding members only",
  only_free: "free subscribers only",
};

export function briefOf(newsletter: Newsletter) {
  const lines = [
    `Newsletter: ${newsletter.name}${newsletter.publication_url ? ` (${newsletter.publication_url})` : " (not connected to Substack yet)"}`,
    newsletter.substack_user_name && `Written by: ${newsletter.substack_user_name}`,
    newsletter.description && `What it is about: ${newsletter.description}`,
    newsletter.audience && `Readers: ${newsletter.audience}`,
    newsletter.voice && `Voice: ${newsletter.voice}`,
    newsletter.pillars.length > 0 && `Recurring themes: ${newsletter.pillars.join("; ")}`,
    newsletter.format && `Format of an issue: ${newsletter.format}`,
    newsletter.avoid && `Never: ${newsletter.avoid}`,
    newsletter.examples && `Passages that sound right:\n${newsletter.examples}`,
    `Time zone: ${newsletter.timezone}`,
    newsletter.cadence > 0 && `Goal: ${newsletter.cadence} issue${newsletter.cadence === 1 ? "" : "s"} a week`,
    `Default audience: ${AUDIENCE_LABELS[newsletter.default_audience] ?? newsletter.default_audience}${newsletter.paid ? " (the publication has paid subscriptions)" : ""}`,
  ];
  return lines.filter(Boolean).join("\n");
}

export const MARKDOWN_GUIDE = `Posts are written in Markdown: # headings (## for sections), **bold**, *italic*, [links](https://…), > quotes, - lists, \`\`\` code. Substack blocks go on a line of their own: ::paywall (paid content below it), ::subscribe (a subscribe button), ::share, ::button[Text](https://…), ::youtube[VIDEO_ID], and ![alt](https://image "caption") for an image. Keep ::embed[…] lines exactly as they are.`;

export const ASSISTS = {
  improve: "Make this passage stronger: clearer sentences, sharper verbs, one idea per paragraph. Keep its meaning, facts and length.",
  shorter: "Make this passage about half as long, keeping its point and voice.",
  longer: "Develop this passage: add a concrete example, detail or step that makes it more useful. Stay in the voice; invent no facts.",
  simplify: "Rewrite this passage in plainer words and shorter sentences, for a reader new to the subject.",
  punchier: "Make this passage livelier and more direct: cut hedging, open strong, end on a line worth remembering.",
  fix: "Fix spelling, grammar and punctuation only. Change nothing else.",
  continue: "Write what comes next, in the same voice: one to three paragraphs that follow from the text before the cursor and lead into the text after it, if any.",
  expand: "Turn these notes or this outline into a full newsletter post, in the voice of the brief: a hook, sections with ## headings, concrete examples, and an ending that invites a reply or a share. Keep every fact, link and quote in the notes; invent none.",
  titles: "Propose six titles for this post, each with a subtitle: specific, honest, curiosity-raising, no clickbait. Vary the angle.",
  review: "Review this draft as a demanding editor: what works, then the five most useful changes (structure, the opening, clarity, cuts, the ending), each with a concrete suggestion. End with a one-line verdict.",
  note: "Write a Substack Note that makes readers want to open this post: two to five short lines in the author's voice, a striking idea or line from the post, no hashtags. Answer with the Note only.",
  summary: "Write a one-sentence description of this post for its preview and search engines, under 160 characters.",
} as const;
export type Assist = keyof typeof ASSISTS;

/** What each assist answers with: text that replaces the selection, text to insert, a whole post, or a note to read. */
export const ASSIST_KIND: Record<Assist, "replace" | "insert" | "document" | "titles" | "feedback" | "text"> = {
  improve: "replace",
  shorter: "replace",
  longer: "replace",
  simplify: "replace",
  punchier: "replace",
  fix: "replace",
  continue: "insert",
  expand: "document",
  titles: "titles",
  review: "feedback",
  note: "text",
  summary: "text",
};

let models: ReturnType<typeof createModels> | undefined;

async function complete(system: string, user: string) {
  if (!models) {
    models = createModels();
    models.setProvider(anthropicProvider());
  }
  const model = models.getModel(config.model.provider, config.model.modelId);
  if (!model) throw new Error(`Unknown model ${config.model.modelId}`);
  const result = await models.complete(model, {
    systemPrompt: system,
    messages: [{ role: "user", content: user, timestamp: Date.now() }],
  });
  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
  if (!text) throw new Error(result.errorMessage ?? "The model gave no text");
  return text;
}

export type AssistInput = {
  action: Assist | "custom";
  /** The selection, or the whole post when nothing is selected. */
  text: string;
  /** For "continue": the text after the cursor. */
  after?: string;
  /** For "custom": what to do. */
  instruction?: string;
  title?: string;
  subtitle?: string;
};

export type AssistResult =
  | { kind: "replace" | "insert" | "document" | "feedback" | "text"; text: string }
  | { kind: "titles"; titles: { title: string; subtitle: string }[] };

export async function assist(newsletter: Newsletter, input: AssistInput): Promise<AssistResult> {
  const custom = input.action === "custom";
  if (!custom && !(input.action in ASSISTS)) throw new Error(`Unknown action ${input.action}`);
  const kind = custom ? "replace" : ASSIST_KIND[input.action as Assist];
  const instruction = custom ? (input.instruction ?? "").slice(0, 1000) : ASSISTS[input.action as Assist];
  if (!instruction.trim()) throw new Error("Say what to change");
  const answerWith = {
    replace: "Answer with the rewritten passage only, in Markdown: no preamble, no quotes around it, no notes.",
    insert: "Answer with the new text only, in Markdown: no preamble, and do not repeat the text around it.",
    document: "Answer with the post's body only, in Markdown, without its title.",
    feedback: "Answer in Markdown, addressed to the author.",
    text: "Answer with the text only.",
    titles: 'Answer with JSON only: [{"title": "...", "subtitle": "..."}, ...]',
  }[kind];
  const system = `You are the editor of a newsletter on Substack, writing with its author.

${briefOf(newsletter)}

${MARKDOWN_GUIDE}

Write in the language of the post. Never invent facts, numbers, names, quotes or links that are not in the post or the brief: leave a [placeholder] when one is needed. ${answerWith}`;
  const heading = [input.title && `Title: ${input.title}`, input.subtitle && `Subtitle: ${input.subtitle}`].filter(Boolean).join("\n");
  const body =
    input.action === "continue"
      ? `<before_cursor>\n${input.text.slice(-12_000)}\n</before_cursor>${input.after?.trim() ? `\n<after_cursor>\n${input.after.slice(0, 4000)}\n</after_cursor>` : ""}`
      : `<text>\n${input.text.slice(0, 60_000)}\n</text>`;
  const answer = (await complete(system, `${instruction}\n\n${heading ? `${heading}\n\n` : ""}${body}`)).replace(
    /^<(text|before_cursor)>\s*|\s*<\/(text|before_cursor)>$/g,
    "",
  );
  if (kind === "titles") {
    const json = answer.slice(answer.indexOf("["), answer.lastIndexOf("]") + 1);
    try {
      const titles = (JSON.parse(json) as { title?: string; subtitle?: string }[])
        .filter((t) => t.title)
        .map((t) => ({ title: String(t.title), subtitle: String(t.subtitle ?? "") }));
      return { kind, titles };
    } catch {
      throw new Error("The model's titles could not be read: try again");
    }
  }
  return { kind, text: answer };
}
