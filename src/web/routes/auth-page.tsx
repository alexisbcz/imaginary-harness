import type { ReactNode } from "react";

/** The sign-in pages: one narrow column on the app's background, like Twenty's. */
export function AuthPage({ form }: { form: ReactNode }) {
  return (
    <div className="flex min-h-svh w-full items-center justify-center bg-t-secondary p-6">
      <div className="w-full max-w-[320px]">{form}</div>
    </div>
  );
}
