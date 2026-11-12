import { useState } from "react";
import { useTranslation } from "react-i18next";

import { createClient } from "@/lib/supabase/client";
import { cleanName, NAME_MAX_LENGTH } from "@/lib/profile";
import {
  AuthError,
  AuthField,
  AuthHeader,
  AuthLink,
  AuthSubmit,
} from "@/components/auth-ui";

export function SignUpForm() {
  const { t } = useTranslation("auth");
  const [name, setName] = useState("");
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
      setError(t("signUp.passwordsMismatch"));
      return;
    }
    const cleaned = cleanName(name);
    if (!cleaned) {
      setError(t("enterName"));
      return;
    }
    setIsLoading(true);

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name: cleaned } },
      });
      if (error) throw error;
      // With email confirmation off (the local default), sign-up already signed the user in.
      if (data.session) location.href = "/";
      else setSuccess(true);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : t("error"));
    } finally {
      setIsLoading(false);
    }
  };

  if (success)
    return (
      <AuthHeader
        title={t("checkEmail")}
        description={t("signUp.confirm")}
      />
    );

  return (
    <form onSubmit={handleSignUp} className="flex flex-col">
      <AuthHeader
        title={t("signUp.title")}
        description={t("signUp.description")}
      />
      <div className="flex flex-col gap-4">
        <AuthField
          label={t("name")}
          type="text"
          placeholder={t("namePlaceholder")}
          autoComplete="name"
          required
          maxLength={NAME_MAX_LENGTH}
          value={name}
          onValueChange={setName}
        />
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
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onValueChange={setPassword}
        />
        <AuthField
          label={t("signUp.repeatPassword")}
          type="password"
          autoComplete="new-password"
          required
          value={repeatPassword}
          onValueChange={setRepeatPassword}
        />
        {error && <AuthError>{error}</AuthError>}
        <AuthSubmit loading={isLoading}>{t("signUp.submit")}</AuthSubmit>
      </div>
      <p className="mt-6 text-center text-t-text-tertiary">
        {t("signUp.haveAccount")}{" "}
        <AuthLink href="/login">{t("signIn")}</AuthLink>
      </p>
    </form>
  );
}
