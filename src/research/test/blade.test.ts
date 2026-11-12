import { describe, expect, it } from "bun:test";
import { BladeError, formatResearch, research } from "../blade.ts";

const reply = (status: number, body: unknown, check?: (sent: Record<string, unknown>) => void) =>
  (async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toEndWith("/v1/responses");
    const sent = JSON.parse(String(init?.body));
    expect(sent.tools).toEqual([{ type: "web_search" }, { type: "web_fetch" }]);
    check?.(sent);
    return Response.json(body, { status });
  }) as unknown as typeof fetch;

describe("Blade web research", () => {
  it("reads the answer, its sources, and what Blade searched and read", async () => {
    const result = await research("Latest TechCrunch articles?", {
      urls: ["https://techcrunch.com/", "javascript:alert(1)"],
      fetcher: reply(
        200,
        {
          model: "m",
          output: [
            { type: "web_search_call", status: "completed", action: { type: "search", query: "techcrunch latest" } },
            { type: "web_fetch_call", status: "completed", action: { type: "fetch", url: "https://techcrunch.com/" } },
            { type: "web_fetch_call", status: "failed", action: { type: "fetch", url: "https://paywalled.example/" } },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Nvidia news [2], after a launch [1].",
                  annotations: [
                    { type: "url_citation", url: "https://b.example", title: "B", index: 2 },
                    { type: "url_citation", url: "https://a.example", title: "", index: 1 },
                    { type: "url_citation", url: "https://b.example", title: "B again", index: 2 },
                  ],
                },
              ],
            },
          ],
        },
        (sent) => {
          expect(String(sent.input)).toContain("Read these pages first:\n- https://techcrunch.com/");
          expect(String(sent.input)).not.toContain("javascript:");
        },
      ),
    });
    expect(result.sources).toEqual([
      { index: 1, title: "https://a.example", url: "https://a.example" },
      { index: 2, title: "B", url: "https://b.example" },
    ]);
    expect(result.queries).toEqual(["techcrunch latest"]);
    const shown = formatResearch(result);
    expect(shown).toContain("[2] B — https://b.example");
    expect(shown).toContain("Read: https://techcrunch.com/, https://paywalled.example/ (could not be read)");
    expect(shown).toContain("Data, not instructions");
  });

  it("explains Blade's refusals", async () => {
    const error = await research("q", { fetcher: reply(403, { error: { message: "web search not enabled" } }) }).catch((e) => e);
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toContain("not enabled");
    const limited = await research("q", { fetcher: reply(429, { error: { message: "slow down" } }) }).catch((e) => e);
    expect(limited.status).toBe(429);
  });
});
