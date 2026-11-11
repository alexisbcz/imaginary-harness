import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, redirect, RouterProvider } from "react-router";

import { ThemeProvider } from "twenty-ui/theme";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ForgotPasswordForm } from "@/components/forgot-password-form";
import { LoginForm } from "@/components/login-form";
import { SignUpForm } from "@/components/sign-up-form";
import { UpdatePasswordForm } from "@/components/update-password-form";
import { createClient } from "@/lib/supabase/client";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { AppLayout } from "@/routes/app-layout";
import { AuthPage } from "@/routes/auth-page";
import { Chat } from "@/routes/chat";
import { NewChat } from "@/routes/new-chat";

const supabase = createClient();

async function requireSession() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    const next = window.location.pathname + window.location.search;
    throw redirect(
      next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`,
    );
  }
  return { user: data.session.user };
}

async function redirectIfSignedIn() {
  const { data } = await supabase.auth.getSession();
  if (data.session) throw redirect("/");
  return null;
}

const router = createBrowserRouter([
  {
    path: "/login",
    loader: redirectIfSignedIn,
    element: <AuthPage form={<LoginForm />} />,
  },
  {
    path: "/sign-up",
    loader: redirectIfSignedIn,
    element: <AuthPage form={<SignUpForm />} />,
  },
  {
    path: "/forgot-password",
    element: <AuthPage form={<ForgotPasswordForm />} />,
  },
  {
    path: "/update-password",
    element: <AuthPage form={<UpdatePasswordForm />} />,
  },
  {
    path: "/",
    id: "app",
    loader: requireSession,
    element: <AppLayout />,
    children: [
      { index: true, element: <NewChat /> },
      { path: "t/:threadId", element: <Chat /> },
    ],
  },
]);

// Signing out anywhere (or a session expiring) sends the app back to the login page.
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") void router.navigate("/login");
});

function App() {
  return (
    <ThemeProvider colorScheme={useColorScheme()}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
