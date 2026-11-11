import type { ReactNode } from "react";
import { cn } from "cn";
import type { ThemeColor } from "twenty-ui/theme";

/**
 * The app's one scale for leading visuals, so labels line up whatever stands before them: an icon, a project or
 * a person.
 */
const sizes = {
  /** In a tab. */
  xs: "size-[18px] text-[9px] [&_svg]:size-[11px]",
  /** Leading a list row, a menu item or a page title. */
  sm: "size-[22px] text-[11px] [&_svg]:size-[13px]",
  /** Leading a row with two lines, or a small card. */
  md: "size-8 text-[14px] [&_svg]:size-[18px]",
  /** On an empty state. */
  lg: "size-11 text-[19px] [&_svg]:size-6",
};

/** Corners about a quarter of the side, as on an app icon. */
const radii = {
  xs: "rounded-[5px]",
  sm: "rounded-[6px]",
  md: "rounded-[8px]",
  lg: "rounded-[11px]",
};

export type TileSize = keyof typeof sizes;

/**
 * An icon on a small glossy tile: a saturated gradient in the tile's color, a white glyph, a lit top edge and a
 * soft shadow of the same color. Each place in the app keeps its color everywhere it shows (the database is
 * green in its tab, its sidebar and its empty state), so the colors become a way to find things.
 *
 * Pick a deep color: sky, cyan, mint, lime, yellow and amber are light at their solid step and a white glyph
 * fades on them.
 */
export function IconTile({
  children,
  size = "sm",
  color = "gray",
  round = false,
  className,
}: {
  children: ReactNode;
  size?: TileSize;
  color?: ThemeColor;
  /** A circle, for people; squares are for things. */
  round?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      style={{ "--tile": `var(--t-color-${color}9)` } as React.CSSProperties}
      className={cn(
        "icon-tile inline-flex shrink-0 items-center justify-center leading-none font-semibold select-none",
        sizes[size],
        // Twenty draws corners as squircles (corner-shape: superellipse); a person is a true circle.
        round ? "rounded-full [corner-shape:round]" : radii[size],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Deep colors a white letter reads on, for names. */
const nameColors: ThemeColor[] = [
  "blue",
  "iris",
  "violet",
  "purple",
  "plum",
  "pink",
  "crimson",
  "ruby",
  "tomato",
  "orange",
  "brown",
  "bronze",
  "jade",
  "green",
  "grass",
  "gold",
];

/** The same name always gets the same color. */
function colorOf(name: string): ThemeColor {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return nameColors[Math.abs(hash) % nameColors.length]!;
}

/** The first letter or digit of a name, or the first character when it has none (an emoji, say). */
function initialOf(name: string) {
  const trimmed = name.trim();
  const letter = trimmed.match(/[\p{L}\p{N}]/u)?.[0] ?? [...trimmed][0] ?? "?";
  return letter.toLocaleUpperCase();
}

/** A project or a person as a tile with their initial: square for a project, round for a person. */
export function NameTile({
  name,
  size = "sm",
  round = false,
  className,
}: {
  name: string;
  size?: TileSize;
  round?: boolean;
  className?: string;
}) {
  return (
    <IconTile
      size={size}
      color={colorOf(name)}
      round={round}
      className={className}
    >
      {initialOf(name)}
    </IconTile>
  );
}
