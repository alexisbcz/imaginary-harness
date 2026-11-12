import { describe, expect, it } from "bun:test";
import { lintSource, looksLikeText } from "./i18n-lint.ts";

describe("what reads as text", () => {
  it("flags words people read", () => {
    for (const text of ["Save", "New project", "Nothing matches.", "Connect to Substack", "Draft", "Écrire un article"])
      expect(looksLikeText(text)).toBe(true);
  });

  it("leaves code, brands and symbols alone", () => {
    for (const text of [
      "draft",
      "only_paid",
      "new-project",
      "flex items-center gap-2 text-t-text",
      "hover:bg-t-hover",
      "https://substack.com",
      "/api/newsletters",
      "image/png",
      "TikTok",
      "LinkedIn · X",
      "SMTP",
      "⌘K",
      "12px",
      "var(--t-color-blue9)",
      "Georgia, 'Iowan Old Style', serif",
      "draftTitle",
      "SELECT id FROM posts",
      "useChart must be used within a <ChartContainer />",
      "",
      "—",
    ])
      expect(looksLikeText(text)).toBe(false);
  });
});

const lint = (code: string) => lintSource("x.tsx", code).map((f) => f.text);

describe("where text hides", () => {
  it("finds JSX text, text attributes, shown strings and errors", () => {
    expect(
      lint(`
        export function A({ ok }) {
          const [error, setError] = useState(null);
          if (!ok) setError("Could not save");
          return (
            <div title="Your posts" className="flex gap-2" data-state="open">
              Hello there
              <input placeholder="Search posts" type="search" />
              {ok ? "Saved" : "Not saved"}
            </div>
          );
        }
        const VIEWS = [{ value: "calendar", label: "Calendar" }];
        throw new Error("Something went wrong");
      `),
    ).toEqual(["Could not save", "Your posts", "Hello there", "Search posts", "Saved", "Not saved", "Calendar", "Something went wrong"]);
  });

  it("ignores keys, comparisons, imports, t() and i18n-ignore", () => {
    expect(
      lint(`
        import x from "Some Module";
        if (status === "Published") t("posts.title");
        const rows = supabase.from("threads").select("id, title, updated_at");
        console.log("Debug message here");
        const map = { "Hello world": 1 };
        // i18n-ignore: a sample shown as code
        const sample = <code>Hello world</code>;
      `),
    ).toEqual([]);
  });

  it("flags full sentences anywhere", () => {
    expect(lint(`const message = "Your newsletter is ready to go.";`)).toEqual(["Your newsletter is ready to go."]);
  });
});
