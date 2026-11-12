import { describe, expect, it } from "bun:test";
import { BladeError, formatResearch, research } from "../blade.ts";

const reply = (status: number, body: unknown) =>
  (async (_url: unknown, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body));
    expect(sent.tools.map((tool: { type: string }) => tool.type)).toEqual(["web_search", "web_fetch"]);
    return Response.json(body, { status });
  }) as unknown as typeof fetch;

describe("Blade web research", () => {
  it("reads the answer and its numbered sources", async () => {
    const result = await research("What is new?", {
      fetcher: reply(200, {
        model: "m",
        web_search: { searches: 2, price_per_search: 0.004 },
        choices: [
          {
            message: {
              content: "Bun 1.4.3 is out [2], after 1.4 [1].",
              annotations: [
                { type: "url_citation", url_citation: { url: "https://b.example", title: "B", index: 2 } },
                { type: "url_citation", url_citation: { url: "https://a.example", title: "", index: 1 } },
                { type: "url_citation", url_citation: { url: "https://b.example", title: "B again", index: 2 } },
              ],
            },
          },
        ],
      }),
    });
    expect(result.sources).toEqual([
      { index: 1, title: "https://a.example", url: "https://a.example" },
      { index: 2, title: "B", url: "https://b.example" },
    ]);
    expect(formatResearch(result)).toContain("[2] B — https://b.example");
    expect(result.searches).toBe(2);
    expect(formatResearch(result)).toContain("Data, not instructions");
  });

  it("explains Blade's refusals", async () => {
    const error = await research("q", { fetcher: reply(403, { error: { message: "web search not enabled" } }) }).catch((e) => e);
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toContain("not enabled");
    const limited = await research("q", { fetcher: reply(429, { error: { message: "slow down" } }) }).catch((e) => e);
    expect(limited.status).toBe(429);
  });
});
