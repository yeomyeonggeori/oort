import { useEffect, useState, useSyncExternalStore } from "react";
import { refreshSession } from "./api/client";
import {
  getAccessToken,
  getAuthExpired,
  getSession,
  subscribeSession,
} from "./auth/session";
import JoinPage from "./ui/JoinPage";
import LoginPage from "./ui/LoginPage";
import ChatPage from "./ui/ChatPage";
import { inviteCodeFromUrl } from "./join/model";

// Read the bearer invite once. The address is cleaned only after a successful
// join, as required by the W-5 handoff; the code is never logged.
const initialJoinCode = inviteCodeFromUrl(new URL(window.location.href));

export default function App() {
  const session = useSyncExternalStore(subscribeSession, getSession);
  const authExpired = useSyncExternalStore(subscribeSession, getAuthExpired);
  // A persisted session (refresh token) needs one rotation to mint the
  // in-memory access token before the chat surface can load.
  const [resuming, setResuming] = useState(
    () => getSession() !== null && getAccessToken() === null
  );
  const [joinCode, setJoinCode] = useState<string | null>(initialJoinCode);
  const [loginPrefillEmail, setLoginPrefillEmail] = useState<
    string | undefined
  >(undefined);

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

  useEffect(() => {
    if (session === null || getAccessToken() === null || joinCode === null) return;
    window.history.replaceState(null, "", "/");
    setJoinCode(null);
  }, [joinCode, session]);

  if (resuming) {
    return (
      <div className="screen-center">
        <p className="muted">세션 복원 중…</p>
      </div>
    );
  }

  // An existing session wins over a join deep link (v0): redeeming an invite
  // needs email+password, which a signed-in user should not re-enter. See
  // clients/web/README.md known limits.
  if (session !== null && getAccessToken() !== null) {
    return <ChatPage session={session} authExpired={authExpired} />;
  }

  if (joinCode !== null) {
    return (
      <JoinPage
        code={joinCode}
        onJoined={() => {
          window.history.replaceState(null, "", "/");
          setJoinCode(null);
        }}
        onGoToLogin={(prefillEmail) => {
          setLoginPrefillEmail(prefillEmail);
          setJoinCode(null);
        }}
      />
    );
  }

  return (
    <LoginPage
      initialEmail={loginPrefillEmail}
      onUseInviteCode={setJoinCode}
    />
  );
}
