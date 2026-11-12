// The `web_research` tool, for every agent: projects, the social and newsletter copilots, and mail. It asks Blade
// to search the web and read pages, and returns a cited answer. Its steps show in the chat through the hooks the
// other extensions already install (they record every tool call).

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { formatResearch, research } from "./blade.ts";

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  isError,
});

export function createResearchExtension() {
  const webResearch = defineTool({
    name: "web_research",
    description:
      "Research a question on the live web: searches, reads the relevant pages, and returns a cited answer with numbered sources. Use it for anything current or that you are unsure of: news, releases, prices, competitors, people, companies, facts to cite in a post, documentation of a library or API. Ask one precise, self-contained question per call (who, what, when; the language of the answer you want). Cite the sources you use.",
    parameters: obj({
      question: str({ description: "One precise, self-contained question" }),
      depth: opt(str({ description: "quick (default) or deep: deep reads more pages, for comparisons and fuller reports" })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      // A rerun after a crash reuses the answer instead of researching (and paying) again.
      const done = await api.memo<string>("research", context);
      if (done) return text(done);
      try {
        const result = await research(args.question, { depth: args.depth?.trim().toLowerCase() === "deep" ? "deep" : "quick" });
        const answer = formatResearch(result);
        if (result.searches !== null)
          console.log(`[research] ${result.searches} searches${result.pricePerSearch !== null ? ` at ${result.pricePerSearch} each` : ""}`);
        await api.memo("research", answer, context);
        return text(answer);
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
      }
    },
  });

  return defineExtension({ name: "research", tools: [webResearch] });
}
