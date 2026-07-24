import { useState } from "react";
import type { LoginResponse } from "@/lib/api";
import { LoginPage } from "@/features/auth/LoginPage";
import { ChatShell } from "@/features/chat/ChatShell";
import { setAccessToken } from "@/lib/api";

export function App() {
  const [session, setSession] = useState<LoginResponse | null>(null);

  if (!session) {
    return <LoginPage onLoggedIn={setSession} />;
  }
  return (
    <ChatShell
      session={session}
      onLogout={() => {
        setAccessToken(null);
        setSession(null);
      }}
    />
  );
}
