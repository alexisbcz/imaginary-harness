import { useState } from "react";
import { useTranslation } from "react-i18next";

import { createClient } from "@/lib/supabase/client";
import {
  AuthError,
  AuthField,
  AuthHeader,
  AuthSubmit,
} from "@/components/auth-ui";

export function UpdatePasswordForm() {
  const { t } = useTranslation("auth");
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
      setError(error instanceof Error ? error.message : t("error"));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleForgotPassword} className="flex flex-col">
      <AuthHeader
        title={t("update.title")}
        description={t("update.description")}
      />
      <div className="flex flex-col gap-4">
        <AuthField
          label={t("update.newPassword")}
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onValueChange={setPassword}
        />
        {error && <AuthError>{error}</AuthError>}
        <AuthSubmit loading={isLoading}>{t("update.submit")}</AuthSubmit>
      </div>
    </form>
  );
}
