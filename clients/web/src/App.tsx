import { useEffect, useState, useSyncExternalStore } from "react";
import { refreshSession } from "./api/client";
import {
  getAccessToken,
  getSession,
  subscribeSession,
} from "./auth/session";
import LoginPage from "./ui/LoginPage";
import ChatPage from "./ui/ChatPage";

export default function App() {
  const session = useSyncExternalStore(subscribeSession, getSession);
  // A persisted session (refresh token) needs one rotation to mint the
  // in-memory access token before the chat surface can load.
  const [resuming, setResuming] = useState(
    () => getSession() !== null && getAccessToken() === null
  );

  useEffect(() => {
    if (!resuming) return;
    let cancelled = false;
    void refreshSession().finally(() => {
      if (!cancelled) setResuming(false);
    });
    return () => {
      cancelled = true;
    };
  }, [resuming]);

  if (resuming) {
    return (
      <div className="screen-center">
        <p className="muted">세션 복원 중…</p>
      </div>
    );
  }

  if (!session || getAccessToken() === null) {
    return <LoginPage />;
  }

  return <ChatPage session={session} />;
}
