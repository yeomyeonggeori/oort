import { useEffect, useState, useSyncExternalStore } from "react";
import { refreshSession } from "./api/client";
import {
  getAccessToken,
  getSession,
  subscribeSession,
} from "./auth/session";
import JoinPage from "./ui/JoinPage";
import LoginPage from "./ui/LoginPage";
import ChatPage from "./ui/ChatPage";

// ---- /join/<code> deep link (MOMO-401, ADR-0121 D2-B) -------------------------
// The invite code is a bearer secret. The path segment is the only place it
// can arrive (D2-B link shape), so capture it ONCE at module load and
// immediately REPLACE the address bar with "/": the code never survives in
// browser history, never rides along on subsequent navigations, and is never
// logged — it leaves memory only inside the POST /v1/join body.
function captureJoinCode(): string | null {
  const match = /^\/join\/([^/]+)\/?$/.exec(window.location.pathname);
  if (match === null) return null;
  let code = match[1];
  try {
    code = decodeURIComponent(code);
  } catch {
    // Malformed escape: submit the raw segment; the server will 404 it.
  }
  window.history.replaceState(null, "", "/");
  return code;
}
const initialJoinCode = captureJoinCode();

export default function App() {
  const session = useSyncExternalStore(subscribeSession, getSession);
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
    return <ChatPage session={session} />;
  }

  if (joinCode !== null) {
    return (
      <JoinPage
        code={joinCode}
        onJoined={() => setJoinCode(null)}
        onGoToLogin={(prefillEmail) => {
          setLoginPrefillEmail(prefillEmail);
          setJoinCode(null);
        }}
      />
    );
  }

  return <LoginPage initialEmail={loginPrefillEmail} />;
}
