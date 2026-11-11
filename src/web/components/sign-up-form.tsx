import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import {
  AuthError,
  AuthField,
  AuthHeader,
  AuthLink,
  AuthSubmit,
} from "@/components/auth-ui";

export function SignUpForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSignUp = async (e: React.FormEvent) => {
    const supabase = createClient();
    e.preventDefault();
    setError(null);

    if (password !== repeatPassword) {
      setError("Passwords do not match");
      return;
    }
    setIsLoading(true);

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
      });
      if (error) throw error;
      // With email confirmation off (the local default), sign-up already signed the user in.
      if (data.session) location.href = "/";
      else setSuccess(true);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  if (success)
    return (
      <AuthHeader
        title="Check your email"
        description="Confirm your account from the link we sent, then sign in."
      />
    );

  return (
    <form onSubmit={handleSignUp} className="flex flex-col">
      <AuthHeader
        title="Create your account"
        description="Describe an app, and watch Richelieu build it."
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
        <AuthField
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onValueChange={setPassword}
        />
        <AuthField
          label="Repeat the password"
          type="password"
          autoComplete="new-password"
          required
          value={repeatPassword}
          onValueChange={setRepeatPassword}
        />
        {error && <AuthError>{error}</AuthError>}
        <AuthSubmit loading={isLoading}>Create the account</AuthSubmit>
      </div>
      <p className="mt-6 text-center text-t-text-tertiary">
        Already have an account? <AuthLink href="/login">Sign in</AuthLink>
      </p>
    </form>
  );
}
