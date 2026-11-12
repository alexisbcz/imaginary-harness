// Web research for every agent (projects, the social and newsletter copilots, mail), through Blade: `web_research`
// searches the web and reads pages to answer a question; `read_web_page` reads one given page. Both return a cited
// answer, and say what was searched and which pages were really read. Their steps show in the chat through the hooks
// the other extensions already install (they record every tool call).

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { formatResearch, research } from "./blade.ts";

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  isError,
});

const urlsOf = (value: string | undefined) =>
  (value ?? "")
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`));

export function createResearchExtension() {
  const webResearch = defineTool({
    name: "web_research",
    description:
      "Research the live web: searches, reads the relevant pages, and returns a cited answer with numbered sources, plus what was searched and which pages were read. Use it for anything current or that you are unsure of: news, releases, prices, competitors, people, companies, facts to cite, documentation of a library or API. Ask one precise, self-contained question per call. When a site or page is the source (\"the latest TechCrunch articles\"), give it in `urls` so it is read directly rather than found through search.",
    parameters: obj({
      question: str({ description: "One precise, self-contained question or request" }),
      urls: opt(str({ description: "Pages or sites to read first, comma-separated (e.g. https://techcrunch.com/)" })),
      depth: opt(str({ description: "quick (default) or deep: deep gives a fuller report, for comparisons" })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      // A rerun after a crash reuses the answer instead of researching (and paying) again.
      const done = await api.memo<string>("research", context);
      if (done) return text(done);
      try {
        const result = await research(args.question, {
          urls: urlsOf(args.urls),
          depth: args.depth?.trim().toLowerCase() === "deep" ? "deep" : "quick",
        });
        const answer = formatResearch(result);
        console.log(`[research] ${result.queries.length} searches, ${result.pages.length} pages read`);
        await api.memo("research", answer, context);
        return text(answer);
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
      }
    },
  });

  const readPage = defineTool({
    name: "read_web_page",
    description:
      "Read one web page (an article, a site's home page, documentation, a changelog) and answer about it: its content, or what you ask of it. Use it when you have the URL.",
    parameters: obj({
      url: str(),
      question: opt(str({ description: "What to get from the page; default: a faithful summary with its key facts and links" })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const done = await api.memo<string>("page", context);
      if (done) return text(done);
      try {
        const [url] = urlsOf(args.url);
        if (!url) return text("Give the page's URL", true);
        const result = await research(
          args.question?.trim() ||
            "Read this page and report its content faithfully: its title, date, key facts, and the links it lists (with their exact URLs).",
          { urls: [url] },
        );
        const answer = formatResearch(result);
        console.log(`[research] read ${url}: ${result.pages.some((p) => p.ok) ? "ok" : "not read"}`);
        await api.memo("page", answer, context);
        return text(answer);
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
      }
    },
  });

  return defineExtension({ name: "research", tools: [webResearch, readPage] });
}
