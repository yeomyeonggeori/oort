import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import { detectLocalHarnesses, desktopPty } from "@/lib/tauri";
import { loadBrowserMirror } from "@/features/workbench/local/localSessions";
import {
  createLoginController,
  type LoginController,
  type LoginControllerDeps,
} from "@/features/welcome/harnessLogin/loginController";
import {
  createUnlinkController,
  type UnlinkController,
  type UnlinkControllerDeps,
} from "@/features/welcome/harnessLogin/unlinkController";
import { harnessProfileRemove } from "@/lib/tauri";

// =============================================================================
// 「내 도구」 카드의 로그인·연결 끊기 PTY 보관소 (ADR-0198 D3, #3568).
//
// 로그인 모달 안에 있던 컨트롤러를 카드 쪽으로 올린다. 그래서 모달을 닫아도(「닫고
// 계속하기」, Esc) PTY가 살아 있고 카드가 인라인으로 「로그인 중」을 말한다. 탭을 옮겨
// 카드가 사라져도 보관소는 모듈에 남는다. 컨트롤러를 끝내는 것은 두 가지뿐이다: 사람이
// 누른 「취소」, 그리고 로그인이 끝난(연결됨·실패) 뒤의 정리.
//
// 이 모듈은 PTY 출력 바이트를 읽지 않는다(컨트롤러의 규율 그대로). 모두 새 PTY 입구가
// 아니라 기존 `loginController`·`unlinkController`를 쓴다.
// =============================================================================

export interface HarnessSessionDeps {
  login: LoginControllerDeps;
  unlink: UnlinkControllerDeps;
}

export function defaultSessionDeps(): HarnessSessionDeps {
  return {
    login: { pty: desktopPty, loadMirror: loadBrowserMirror, detect: detectLocalHarnesses },
    unlink: {
      pty: desktopPty,
      loadMirror: loadBrowserMirror,
      remove: harnessProfileRemove,
      verify: detectLocalHarnesses,
    },
  };
}

interface Entry {
  login: LoginController | null;
  unlink: UnlinkController | null;
}

export interface HarnessSessionSnapshot {
  readonly version: number;
  login: (harness: LocalHarnessId) => LoginController | null;
  unlink: (harness: LocalHarnessId) => UnlinkController | null;
}

export function createHarnessSessionStore(makeDeps: () => HarnessSessionDeps = defaultSessionDeps) {
  const entries = new Map<LocalHarnessId, Entry>();
  const stops = new Map<object, () => void>();
  const listeners = new Set<() => void>();
  let version = 0;
  let snapshot = build();

  function build(): HarnessSessionSnapshot {
    return {
      version,
      login: (harness) => entries.get(harness)?.login ?? null,
      unlink: (harness) => entries.get(harness)?.unlink ?? null,
    };
  }
  const notify = () => {
    version += 1;
    snapshot = build();
    listeners.forEach((listener) => listener());
  };
  const entry = (harness: LocalHarnessId): Entry => {
    let found = entries.get(harness);
    if (!found) {
      found = { login: null, unlink: null };
      entries.set(harness, found);
    }
    return found;
  };

  const store = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 이미 도는 로그인이 있으면 그것을 돌려준다(두 번 띄우지 않는다). */
    startLogin(harness: LocalHarnessId): LoginController {
      const slot = entry(harness);
      if (slot.login && !isLoginSettled(slot.login)) return slot.login;
      store.dismissLogin(harness);
      const controller = createLoginController(harness, "browser", makeDeps().login);
      slot.login = controller;
      stops.set(controller, controller.subscribe(notify));
      controller.open();
      notify();
      return controller;
    },
    /** 취소 또는 끝난 로그인의 정리: PTY를 끝내고 카드를 평소로 돌린다. */
    dismissLogin(harness: LocalHarnessId) {
      const slot = entries.get(harness);
      const controller = slot?.login;
      if (!slot || !controller) return;
      slot.login = null;
      stops.get(controller)?.();
      stops.delete(controller);
      controller.dispose();
      notify();
    },
    /** 이 맥의 기본 로그인을 공식 CLI로 로그아웃하고 상태 명령으로 확인한다. */
    startDisconnect(harness: LocalHarnessId): UnlinkController {
      const slot = entry(harness);
      if (slot.unlink) {
        const phase = slot.unlink.getState().status.phase;
        if (phase === "signing-out" || phase === "removing") return slot.unlink;
        store.dismissDisconnect(harness);
      }
      const controller = createUnlinkController({ harness, label: null }, makeDeps().unlink);
      slot.unlink = controller;
      stops.set(controller, controller.subscribe(notify));
      controller.confirm();
      notify();
      return controller;
    },
    dismissDisconnect(harness: LocalHarnessId) {
      const slot = entries.get(harness);
      const controller = slot?.unlink;
      if (!slot || !controller) return;
      slot.unlink = null;
      stops.get(controller)?.();
      stops.delete(controller);
      controller.dispose();
      notify();
    },
  };
  return store;
}

function isLoginSettled(controller: LoginController): boolean {
  const phase = controller.getState().status.phase;
  return phase === "connected" || phase === "failed";
}

export type HarnessSessionStore = ReturnType<typeof createHarnessSessionStore>;

/** 앱 하나에 보관소 하나. 카드와 모달이 같은 것을 본다. */
export const harnessSessions: HarnessSessionStore = createHarnessSessionStore();
