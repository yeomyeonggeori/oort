import {installCoreHost} from '@momo/core/runtime/host';
import {absoluteApiBase, apiBase} from '../storage/serverBase';
import {sessionPort} from '../storage/secureSession';

// =============================================================================
// The iOS client's implementation of the core host port (ADR-0137 D3).
//
// `@momo/core` holds the domain logic and none of the platform. This file is the
// one place that hands it the platform-backed answers it needs — which server
// this device talks to, and where the session tokens live — by pointing the port
// at the modules that own them (`storage/serverBase.ts`,
// `storage/secureSession.ts`).
//
// The web sibling is `clients/web/src/lib/coreHost.ts` and it is deliberately
// the same shape: installed as a module side effect, imported first at the entry
// point, with a test asserting it happened. Two hosts, one port, one core.
//
// `buildMode` is the only line that could not simply be pointed at an existing
// module. On web it reads `import.meta.env.MODE`; `import.meta` does not exist
// under Metro/Hermes, which is the concrete reason the core takes this as a port
// instead of reading a global. React Native's answer is `__DEV__`.
// =============================================================================

installCoreHost({
  apiBase,
  absoluteApiBase,
  buildMode: () => (__DEV__ ? 'development' : 'production'),
  session: sessionPort,
});
