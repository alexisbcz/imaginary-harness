import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import {
  AuthError,
  AuthField,
  AuthHeader,
  AuthSubmit,
} from "@/components/auth-ui";

export function UpdatePasswordForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleForgotPassword = async (e: React.FormEvent) => {
    const supabase = createClient();
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      // Update this route to redirect to an authenticated route. The user already has an active session.
      location.href = "/";
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleForgotPassword} className="flex flex-col">
      <AuthHeader
        title="Choose a new password"
        description="You will stay signed in with it."
      />
      <div className="flex flex-col gap-4">
        <AuthField
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onValueChange={setPassword}
        />
        {error && <AuthError>{error}</AuthError>}
        <AuthSubmit loading={isLoading}>Save the password</AuthSubmit>
      </div>
    </form>
  );
}
