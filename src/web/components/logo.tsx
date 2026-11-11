/** Richelieu's mark: a cardinal-red tile with a serif R. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center font-serif font-semibold text-white"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.25),
        fontSize: size * 0.62,
        background: "oklch(0.5 0.19 22)",
        boxShadow: "inset 0 -1px 0 rgb(0 0 0 / 0.16)",
      }}
    >
      R
    </span>
  );
}
