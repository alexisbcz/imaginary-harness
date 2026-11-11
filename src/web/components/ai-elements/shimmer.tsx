import { memo, type CSSProperties, type ElementType } from "react";
import { cn } from "cn";

/**
 * Text with a light sweeping across it, for "the agent is working" states. Adapted from Vercel's AI Elements,
 * with a CSS animation in place of `motion`. It holds still when the viewer prefers reduced motion.
 */
export const Shimmer = memo(function Shimmer({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: {
  children: string;
  as?: ElementType;
  className?: string;
  /** Seconds per sweep. */
  duration?: number;
  /** Width of the light, in pixels per character. */
  spread?: number;
}) {
  return (
    <Component
      className={cn(
        "relative inline-block animate-[shimmer_var(--duration)_linear_infinite] bg-[length:250%_100%,auto] bg-clip-text text-transparent motion-reduce:animate-none",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className,
      )}
      style={
        {
          "--spread": `${children.length * spread}px`,
          "--duration": `${duration}s`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
        } as CSSProperties
      }
    >
      {children}
    </Component>
  );
});
