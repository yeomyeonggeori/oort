import { describe, expect, it } from "vitest";
import {
  decideAutoAdvance,
  initialAutoAdvanceArmed,
  type HostedWizardLaunch,
} from "./hostedWizardLaunch";

const launch = (
  overrides: Partial<HostedWizardLaunch> = {}
): HostedWizardLaunch => ({
  presetId: "grok",
  displayName: "그록봇",
  handle: "grokbot",
  autoAdvance: "create",
  ...overrides,
});

describe("원클릭 자동 발급은 열림 시점 online 에서만 소비한다", () => {
  it("오프라인으로 열리면 무장하지 않는다", () => {
    expect(initialAutoAdvanceArmed(launch(), true)).toBe(false);
    expect(initialAutoAdvanceArmed(launch(), false)).toBe(true);
    expect(initialAutoAdvanceArmed(null, false)).toBe(false);
    expect(
      initialAutoAdvanceArmed(launch({ autoAdvance: undefined }), false)
    ).toBe(false);
  });

  it("유예됐거나 초안이 시드와 다르면 무장 해제하고 발사하지 않는다", () => {
    expect(
      decideAutoAdvance({
        armed: true,
        offline: true,
        autoAdvance: "create",
        draftReady: true,
        draftMatchesSeed: true,
        hasConnectionId: false,
      })
    ).toBe("disarm");
    expect(
      decideAutoAdvance({
        armed: true,
        offline: false,
        autoAdvance: "create",
        draftReady: true,
        draftMatchesSeed: false,
        hasConnectionId: false,
      })
    ).toBe("disarm");
    expect(
      decideAutoAdvance({
        armed: false,
        offline: false,
        autoAdvance: "create",
        draftReady: true,
        draftMatchesSeed: true,
        hasConnectionId: false,
      })
    ).toBe("wait");
  });

  it("온라인 열림이고 시드가 그대로면 create 를 한 번 쏜다", () => {
    expect(
      decideAutoAdvance({
        armed: true,
        offline: false,
        autoAdvance: "create",
        draftReady: true,
        draftMatchesSeed: true,
        hasConnectionId: false,
      })
    ).toBe("fire-create");
  });

  it("초안이 아직 준비되지 않으면 기다린다", () => {
    expect(
      decideAutoAdvance({
        armed: true,
        offline: false,
        autoAdvance: "create",
        draftReady: false,
        draftMatchesSeed: true,
        hasConnectionId: false,
      })
    ).toBe("wait");
  });

  it("복구 원클릭은 연결 id 가 있으면 regenerate 를 쏜다", () => {
    expect(
      decideAutoAdvance({
        armed: true,
        offline: false,
        autoAdvance: "regenerate",
        draftReady: true,
        draftMatchesSeed: true,
        hasConnectionId: true,
      })
    ).toBe("fire-regenerate");
    expect(
      decideAutoAdvance({
        armed: true,
        offline: false,
        autoAdvance: "regenerate",
        draftReady: true,
        draftMatchesSeed: true,
        hasConnectionId: false,
      })
    ).toBe("wait");
  });
});
