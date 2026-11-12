import { useState } from "react";
import { useTranslation } from "react-i18next";

import { createClient } from "@/lib/supabase/client";
import {
  AuthError,
  AuthField,
  AuthHeader,
  AuthLink,
  AuthSubmit,
} from "@/components/auth-ui";

export function ForgotPasswordForm() {
  const { t } = useTranslation("auth");
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
      setError(error instanceof Error ? error.message : t("error"));
    } finally {
      setIsLoading(false);
    }
  };

  if (success)
    return (
      <div className="flex flex-col">
        <AuthHeader
          title={t("checkEmail")}
          description={t("forgot.sent")}
        />
        <p className="text-center text-t-text-tertiary">
          <AuthLink href="/login">{t("forgot.backToSignIn")}</AuthLink>
        </p>
      </div>
    );

  return (
    <form onSubmit={handleForgotPassword} className="flex flex-col">
      <AuthHeader
        title={t("forgot.title")}
        description={t("forgot.description")}
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
        {error && <AuthError>{error}</AuthError>}
        <AuthSubmit loading={isLoading}>{t("forgot.submit")}</AuthSubmit>
      </div>
      <p className="mt-6 text-center text-t-text-tertiary">
        {t("forgot.remembered")}{" "}
        <AuthLink href="/login">{t("signIn")}</AuthLink>
      </p>
    </form>
  );
}
