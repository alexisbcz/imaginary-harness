// The brand brief as the model reads it, and one-shot rewrites for the post composer (shorter, punchier, adapted
// to a platform…), which answer in a second rather than through the copilot's conversation.

import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { config } from "../config.ts";
import { platformInfo } from "./platforms.ts";
import type { Brand, SocialAccount } from "./service.ts";

export function briefOf(brand: Brand, accounts: SocialAccount[] = []) {
  const lines = [
    `Brand: ${brand.name}${brand.website ? ` (${brand.website})` : ""}`,
    brand.description && `What it does: ${brand.description}`,
    brand.audience && `Audience: ${brand.audience}`,
    brand.voice && `Voice: ${brand.voice}`,
    brand.pillars.length > 0 && `Content pillars: ${brand.pillars.join("; ")}`,
    brand.avoid && `Never: ${brand.avoid}`,
    brand.examples && `Posts that sound right:\n${brand.examples}`,
    `Time zone: ${brand.timezone}`,
    Object.keys(brand.cadence).length > 0 &&
      `Posting goal: ${Object.entries(brand.cadence)
        .map(([platform, count]) => `${count}/week on ${platformInfo(platform).label}`)
        .join(", ")}`,
    accounts.length > 0
      ? `Connected accounts: ${accounts.map((a) => `${platformInfo(a.platform).label} ${a.username} (id ${a.id})`).join(", ")}`
      : "No account is connected yet.",
  ];
  return lines.filter(Boolean).join("\n");
}

export const REWRITES = {
  improve: "Make it stronger: a sharper first line, tighter sentences, one clear point. Keep its meaning and length.",
  shorter: "Make it about half as long, keeping the point and the voice.",
  longer: "Develop it: add a concrete example or detail that makes it more useful. Stay in the voice.",
  hook: "Rewrite only the opening line into a hook that makes the reader stop scrolling; keep the rest.",
  casual: "Make it warmer and more conversational.",
  professional: "Make it more polished and professional, without corporate jargon.",
  emoji: "Add a few fitting emoji where they help reading; no more than one per paragraph.",
  hashtags: "Add 2 to 4 relevant hashtags at the end, none generic.",
  fix: "Fix spelling, grammar and punctuation only. Change nothing else.",
} as const;
export type Rewrite = keyof typeof REWRITES;

let models: ReturnType<typeof createModels> | undefined;

/** Rewrites a post's text in the brand's voice, for a platform. */
export async function rewrite(
  brand: Brand,
  input: { text: string; instruction: string; platform?: string },
): Promise<string> {
  if (!models) {
    models = createModels();
    models.setProvider(anthropicProvider());
  }
  const model = models.getModel(config.model.provider, config.model.modelId);
  if (!model) throw new Error(`Unknown model ${config.model.modelId}`);
  const preset = REWRITES[input.instruction as Rewrite];
  const platform = input.platform ? platformInfo(input.platform) : undefined;
  const result = await models.complete(model, {
    systemPrompt: `You edit social media posts for a brand. Answer with the post's new text only: no preamble, no quotes, no notes.

${briefOf(brand)}${platform ? `\n\nThe post is for ${platform.label}: at most ${platform.limit} characters, written the way that platform reads.` : ""}

Keep the post's language. Never invent facts, numbers, names or links that are not in the post or the brief.`,
    messages: [
      {
        role: "user",
        content: `${preset ?? input.instruction.slice(0, 500)}\n\n<post>\n${input.text.slice(0, 8000)}\n</post>`,
        timestamp: Date.now(),
      },
    ],
  });
  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim()
    .replace(/^<post>\s*|\s*<\/post>$/g, "");
  if (!text) throw new Error(result.errorMessage ?? "The model gave no text");
  return text;
}
