import type { ComponentType } from "react";
import {
  IconBrandBluesky,
  IconBrandFacebookFilled,
  IconBrandInstagram,
  IconBrandLinkedinFilled,
  IconBrandPinterestFilled,
  IconBrandThreads,
  IconBrandTiktokFilled,
  IconBrandX,
  IconBrandYoutubeFilled,
  IconWorld,
} from "@tabler/icons-react";
import { cn } from "cn";
import type { ThemeColor } from "twenty-ui/theme";

import { IconTile, type TileSize } from "@/components/icon-tile";
import { platformInfo } from "@/lib/social";

type Icon = ComponentType<{ size?: number; className?: string }>;

const ICONS: Record<string, { icon: Icon; color: ThemeColor }> = {
  linkedin: { icon: IconBrandLinkedinFilled, color: "blue" },
  twitter: { icon: IconBrandX, color: "gray" },
  instagram: { icon: IconBrandInstagram, color: "crimson" },
  threads: { icon: IconBrandThreads, color: "gray" },
  facebook: { icon: IconBrandFacebookFilled, color: "iris" },
  tiktok: { icon: IconBrandTiktokFilled, color: "gray" },
  youtube: { icon: IconBrandYoutubeFilled, color: "red" },
  bluesky: { icon: IconBrandBluesky, color: "blue" },
  pinterest: { icon: IconBrandPinterestFilled, color: "ruby" },
};

export const platformColor = (platform: string): ThemeColor => ICONS[platform]?.color ?? "gray";

/** A platform's glyph alone, in the text's color. */
export function PlatformGlyph({ platform, size = 14, className }: { platform: string; size?: number; className?: string }) {
  const Glyph = ICONS[platform]?.icon ?? IconWorld;
  return <Glyph size={size} className={cn("shrink-0", className)} aria-label={platformInfo(platform).label} />;
}

/** A platform as a tile, in its color: how the app shows a platform everywhere. */
export function PlatformTile({ platform, size = "sm", className }: { platform: string; size?: TileSize; className?: string }) {
  const { icon: Glyph, color } = ICONS[platform] ?? { icon: IconWorld, color: "gray" as ThemeColor };
  return (
    <IconTile size={size} color={color} className={className}>
      <Glyph />
    </IconTile>
  );
}

/** An account's picture with its platform's badge in the corner. */
export function AccountAvatar({
  avatar,
  platform,
  name,
  size = 28,
  className,
}: {
  avatar: string | null;
  platform: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const badge = Math.max(12, Math.round(size * 0.45));
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      {avatar ? (
        <img
          src={avatar}
          alt=""
          referrerPolicy="no-referrer"
          className="size-full rounded-full border border-t-border-light object-cover"
        />
      ) : (
        <span className="flex size-full items-center justify-center rounded-full bg-t-tertiary text-[11px] font-semibold text-t-text-secondary">
          {name.trim()[0]?.toUpperCase() ?? "?"}
        </span>
      )}
      <span
        className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-t-primary p-px"
        style={{ width: badge + 2, height: badge + 2 }}
      >
        <PlatformTile platform={platform} size="xs" className="!size-full !text-[8px] [&_svg]:!size-[70%]" />
      </span>
    </span>
  );
}
