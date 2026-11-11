import { useId, type ReactNode } from "react";
import { Field, Input, Button } from "twenty-ui/primitives/input";

import { Logo } from "@/components/logo";

/** The top of each sign-in page: the mark, a title and a line under it, centered like Twenty's. */
export function AuthHeader({
  title,
  description,
}: {
  title: string;
  description: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col items-center gap-4 text-center">
      <Logo size={48} />
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[20px] font-semibold text-t-text">{title}</h1>
        <p className="leading-[1.45] text-t-text-tertiary">{description}</p>
      </div>
    </div>
  );
}

export function AuthField({
  label,
  aside,
  id,
  ...props
}: {
  label: string;
  aside?: ReactNode;
} & Parameters<typeof Input>[0]) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  return (
    <Field.Root className="flex flex-col gap-1.5">
      <div className="flex items-center">
        <Field.Label
          htmlFor={fieldId}
          className="text-[12px] font-medium text-t-text-tertiary"
        >
          {label}
        </Field.Label>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      <Input size="md" {...props} id={fieldId} />
    </Field.Root>
  );
}

export function AuthSubmit({
  loading,
  children,
}: {
  loading: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="submit"
      variant="solid"
      color="neutral"
      elevated
      fullWidth
      loading={loading}
      className="mt-2"
    >
      {children}
    </Button>
  );
}

export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-sm bg-[var(--t-background-danger)] px-2.5 py-2 text-t-text-danger">
      {children}
    </p>
  );
}

export function AuthLink(props: React.ComponentProps<"a">) {
  return (
    <a
      {...props}
      className="text-t-text-secondary underline decoration-t-border-strong underline-offset-[3px] hover:text-t-text hover:decoration-current"
    />
  );
}
