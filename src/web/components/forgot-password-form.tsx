import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import {
  AuthError,
  AuthField,
  AuthHeader,
  AuthLink,
  AuthSubmit,
} from "@/components/auth-ui";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleForgotPassword = async (e: React.FormEvent) => {
    const supabase = createClient();
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      // The url which will be included in the email. This URL needs to be configured in your redirect URLs in the Supabase dashboard at https://supabase.com/dashboard/project/_/auth/url-configuration
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/update-password`,
      });
      if (error) throw error;
      setSuccess(true);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  if (success)
    return (
      <div className="flex flex-col">
        <AuthHeader
          title="Check your email"
          description="If an account uses this address, a link to reset its password is on its way."
        />
        <p className="text-center text-t-text-tertiary">
          <AuthLink href="/login">Back to sign in</AuthLink>
        </p>
      </div>
    );

  return (
    <form onSubmit={handleForgotPassword} className="flex flex-col">
      <AuthHeader
        title="Reset your password"
        description="Enter your email, and we will send you a link to choose a new one."
      />
      <div className="flex flex-col gap-4">
        <AuthField
          label="Email"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          required
          value={email}
          onValueChange={setEmail}
        />
        {error && <AuthError>{error}</AuthError>}
        <AuthSubmit loading={isLoading}>Send the link</AuthSubmit>
      </div>
      <p className="mt-6 text-center text-t-text-tertiary">
        Remembered it? <AuthLink href="/login">Sign in</AuthLink>
      </p>
    </form>
  );
}
