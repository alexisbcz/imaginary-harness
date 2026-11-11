import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { cleanName, NAME_MAX_LENGTH, pathAfterName } from "@/lib/profile";
import {
  AuthError,
  AuthField,
  AuthHeader,
  AuthSubmit,
} from "@/components/auth-ui";

export function NameForm() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleName = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleaned = cleanName(name);
    if (!cleaned) {
      setError("Enter your name");
      return;
    }
    setIsLoading(true);

    try {
      const { error } = await createClient().from("profiles").insert({
        name: cleaned,
      });
      // 23505: the row was already created, for example by sign-up.
      if (error && error.code !== "23505") {
        throw new Error(
          error.code === "23514" ? "Enter your name" : error.message,
        );
      }
      const next = new URLSearchParams(window.location.search).get("next");
      location.href = pathAfterName(next);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleName} className="flex flex-col">
      <AuthHeader
        title="What is your name?"
        description="Your name shows at the bottom of the sidebar."
      />
      <div className="flex flex-col gap-4">
        <AuthField
          label="Name"
          type="text"
          placeholder="Ada Lovelace"
          autoComplete="name"
          required
          maxLength={NAME_MAX_LENGTH}
          value={name}
          onValueChange={setName}
        />
        {error && <AuthError>{error}</AuthError>}
        <AuthSubmit loading={isLoading}>Save your name</AuthSubmit>
      </div>
      <p className="mt-6 text-center">
        <button
          type="button"
          className="text-t-text-secondary underline decoration-t-border-strong underline-offset-[3px] hover:text-t-text hover:decoration-current"
          onClick={() => void createClient().auth.signOut()}
        >
          Sign out
        </button>
      </p>
    </form>
  );
}
