import type { ComponentProps } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";

/**
 * Suggested prompts, wrapping onto more lines as needed. Adapted from Vercel's AI Elements, whose single
 * sideways-scrolling row clipped the last suggestion mid-word.
 */
export function Suggestions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  );
}

export function Suggestion({
  suggestion,
  onClick,
  className,
  variant = "outline",
  size = "sm",
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn("rounded-full px-4", className)}
      onClick={() => onClick?.(suggestion)}
      {...props}
    >
      {children || suggestion}
    </Button>
  );
}
