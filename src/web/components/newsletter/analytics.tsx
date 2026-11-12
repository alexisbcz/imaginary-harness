// How the newsletter is doing: subscribers, open rate and views, and each sent post's numbers, sortable.

import { useMemo, useState } from "react";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button } from "twenty-ui/primitives/input";
import { IconArrowDown, IconRefresh, IconSparkles } from "@tabler/icons-react";
import { cn } from "cn";

import { compact, rate, useAnalytics, type Analytics, type Newsletter } from "@/lib/newsletter";

type Row = Analytics["posts"][number];
const COLUMNS: { key: keyof Row; label: string; format: (v: number | null) => string }[] = [
  { key: "sent", label: "Sent", format: compact },
  { key: "open_rate", label: "Open rate", format: rate },
  { key: "click_through_rate", label: "Click rate", format: rate },
  { key: "views", label: "Views", format: compact },
  { key: "likes", label: "Likes", format: compact },
  { key: "restacks", label: "Restacks", format: compact },
  { key: "subscribes", label: "New subs", format: compact },
  { key: "unsubscribes", label: "Unsubs", format: compact },
];

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-t-border px-3 py-2.5">
      <span className="text-[12px] text-t-text-tertiary">{label}</span>
      <span className="text-[20px] font-semibold text-t-text tabular-nums">{value}</span>
      {detail && <span className="text-[12px] text-t-text-secondary tabular-nums">{detail}</span>}
    </div>
  );
}

export function NewsletterAnalytics({ newsletter, onAsk }: { newsletter: Newsletter; onAsk: (message: string) => void }) {
  const [fresh, setFresh] = useState(0);
  const { data, error, loading } = useAnalytics(newsletter, fresh);
  const [sort, setSort] = useState<keyof Row>("post_date");

  const rows = useMemo(() => {
    const list = [...(data?.posts ?? [])];
    list.sort((a, b) => {
      const x = a[sort];
      const y = b[sort];
      if (typeof x === "string" || typeof y === "string") return String(y ?? "").localeCompare(String(x ?? ""));
      return (Number(y) || 0) - (Number(x) || 0);
    });
    return list;
  }, [data, sort]);

  if (error) return <p className="m-6 text-t-text-danger">{error}</p>;
  if (!data)
    return (
      <div className="flex h-full items-center justify-center">
        <Loader />
      </div>
    );
  const s = data.stats;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-6 px-5 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-t-text-tertiary">From Substack · {new Date(data.synced_at).toLocaleTimeString()}</span>
          <span className="flex-1" />
          <Button size="sm" variant="outline" startIcon={<IconSparkles size={14} />} onClick={() =>
            onAsk("Read our newsletter's numbers. Which posts did readers open, click and share most, and what do they have in common? Give me three concrete changes for the next issues.")
          }>
            Explain with the copilot
          </Button>
          <Button size="sm" variant="ghost" startIcon={loading ? <Loader /> : <IconRefresh size={14} />} onClick={() => setFresh((n) => n + 1)}>
            Refresh
          </Button>
        </div>
        {s ? (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="Subscribers" value={compact(s.subscribers)} detail={s.subscribers_last_30_days !== null ? `+${compact(s.subscribers_last_30_days)} in 30 days` : undefined} />
            <Stat label="Paid subscribers" value={compact(s.paid_subscribers)} detail={s.arr !== null ? `${compact(s.arr)} a year` : undefined} />
            <Stat label="Open rate (30 days)" value={rate(s.open_rate)} />
            <Stat label="Views (30 days)" value={compact(s.views_30d)} detail={s.views_delta_30d !== null ? `${s.views_delta_30d >= 0 ? "+" : ""}${compact(s.views_delta_30d)} vs before` : undefined} />
          </div>
        ) : (
          <p className="text-t-text-tertiary">Substack did not return the publication's totals.</p>
        )}
        <section className="flex flex-col gap-2">
          <h2 className="text-[15px] font-semibold text-t-text">Posts</h2>
          {rows.length === 0 ? (
            <p className="text-t-text-tertiary">No sent posts yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-t-border">
              <table className="w-full min-w-[760px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-t-border text-[12px] text-t-text-tertiary">
                    <th className="px-3 py-2 font-medium">
                      <button type="button" className="flex items-center gap-1" onClick={() => setSort("post_date")}>
                        Post {sort === "post_date" && <IconArrowDown size={12} />}
                      </button>
                    </th>
                    {COLUMNS.map((c) => (
                      <th key={c.key} className="px-3 py-2 text-right font-medium">
                        <button type="button" className={cn("ml-auto flex items-center gap-1", sort === c.key && "text-t-text")} onClick={() => setSort(c.key)}>
                          {c.label} {sort === c.key && <IconArrowDown size={12} />}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.post_id} className="border-b border-t-border-light last:border-0">
                      <td className="max-w-[280px] px-3 py-2">
                        <div className="truncate text-t-text">{r.title}</div>
                        <div className="text-[12px] text-t-text-tertiary">{r.post_date ? new Date(r.post_date).toLocaleDateString() : ""}</div>
                      </td>
                      {COLUMNS.map((c) => (
                        <td key={c.key} className="px-3 py-2 text-right text-t-text-secondary tabular-nums">
                          {c.format(r[c.key] as number | null)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
