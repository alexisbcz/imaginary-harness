import type { ReactNode } from "react";
import { cn } from "cn";
import { Select } from "twenty-ui/primitives/input";

/** Twenty's select for the common case: a few options, one value, a small trigger. */
export function SimpleSelect<T extends string>({
  value,
  onValueChange,
  options,
  label,
  bare = false,
  className,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; label: ReactNode }[];
  /** Names the select for screen readers. */
  label: string;
  /** Text only, without the field's border and chevron: for a segment of a pill. */
  bare?: boolean;
  className?: string;
}) {
  return (
    <Select.Root
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next as T);
      }}
    >
      <Select.Trigger
        size="sm"
        aria-label={label}
        className={cn(
          bare &&
            "h-full min-h-0 w-auto min-w-0 rounded-none border-0 bg-transparent px-2 shadow-none outline-none hover:bg-t-hover focus-visible:bg-t-hover data-[popup-open]:bg-t-hover",
          className,
        )}
      >
        <Select.Value />
        {!bare && <Select.Icon />}
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner alignItemWithTrigger={false}>
          <Select.Popup>
            <Select.List>
              {options.map((option) => (
                <Select.Item key={option.value} value={option.value}>
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator />
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
