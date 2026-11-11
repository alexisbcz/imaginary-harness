import type { ReactNode } from "react";

/** The Supabase UI auth forms, centered. */
export function AuthPage({ form }: { form: ReactNode }) {
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">{form}</div>
    </div>
  );
}
