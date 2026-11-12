import { useState } from "react";
import { useTranslation } from "react-i18next";

import { safeNextPath } from "@/lib/safe-next-path";
import { createClient } from "@/lib/supabase/client";
import {
  AuthError,
  AuthField,
  AuthHeader,
  AuthLink,
  AuthSubmit,
} from "@/components/auth-ui";

export function LoginForm() {
  const { t } = useTranslation("auth");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      // Update this route to redirect to an authenticated route. The user already has an active session.
      const next = new URLSearchParams(window.location.search).get("next");
      location.href = safeNextPath(next, "/");
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : t("error"));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleLogin} className="flex flex-col">
      <AuthHeader
        title={t("login.title")}
        description={t("login.description")}
      />
      <div className="flex flex-col gap-4">
        <AuthField
          label={t("email")}
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          required
          value={email}
          onValueChange={setEmail}
        />
        <AuthField
          label={t("password")}
          aside={<AuthLink href="/forgot-password">{t("login.forgot")}</AuthLink>}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onValueChange={setPassword}
        />
        {error && <AuthError>{error}</AuthError>}
        <AuthSubmit loading={isLoading}>{t("signIn")}</AuthSubmit>
      </div>
      <p className="mt-6 text-center text-t-text-tertiary">
        {t("login.noAccount")}{" "}
        <AuthLink href="/sign-up">{t("login.signUp")}</AuthLink>
      </p>
    </form>
  );
}
