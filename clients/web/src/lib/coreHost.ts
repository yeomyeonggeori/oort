import { installCoreHost } from "@momo/core/runtime/host";
import { absoluteApiBase, apiBase } from "./serverBase";
import {
  applyLogin,
  applyRotation,
  clearSession,
  getAccessToken,
  getPersistedSession,
  getRefreshToken,
  markAuthExpired,
} from "./session";

// =============================================================================
// The web client's implementation of the core host port (ADR-0137 D3).
//
// `@momo/core` holds the domain logic and none of the platform. This file is the
// one place that hands it the two platform-backed answers it needs — which
// server this device talks to, and where the session tokens live — by pointing
// the port at the modules that already owned them (`serverBase.ts`,
// `session.ts`). Nothing here is new behaviour: it is the same functions the
// same callers were reaching for directly before the extraction.
//
// It is installed as a module side effect and imported FIRST in `main.tsx`, so
// there is no window in which core code could ask for a base and get the inert
// default. `coreHostInstalled()` exists so a test can assert that, and
// `coreHost.test.ts` does.
// =============================================================================

installCoreHost({
  apiBase,
  absoluteApiBase,
  buildMode: () => import.meta.env.MODE,
  session: {
    getAccessToken,
    getRefreshToken,
    getPersistedSession,
    applyLogin,
    applyRotation,
    markAuthExpired,
    clearSession,
  },
});
