import { describe, expect, it } from "vitest";
import { workstreamListFromWire, workstreamRunListFromWire } from "./api";
import { WireShapeError } from "./wire";

const workstream = {
  id: "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAAA77",
  workspaceId: "BBBBBBBB-BBBB-7BBB-8BBB-BBBBBBBBBB77",
  channelId: "CCCCCCCC-CCCC-7CCC-8CCC-CCCCCCCCCC77",
  rootMessageId: "DDDDDDDD-DDDD-7DDD-8DDD-DDDDDDDDDD77",
  goal: "릴리스 회귀 재현과 원인 좁히기",
  status: "active",
  createdByMemberId: "EEEEEEEE-EEEE-7EEE-8EEE-EEEEEEEEEE77",
  createdAtMs: 1_785_238_400_000,
  updatedAtMs: 1_785_238_500_000,
  runCount: 3,
  activeRunCount: 1,
};

const run = {
  id: "11111111-1111-7111-8111-111111111177",
  memberId: "EEEEEEEE-EEEE-7EEE-8EEE-EEEEEEEEEE77",
  hostId: "22222222-2222-7222-8222-222222222277",
  tool: "codex",
  label: "회귀 재현",
  status: "orphaned",
  startedAtMs: 1_785_238_400_000,
};

describe("workstream REST decoders", () => {
  it("normalizes every UUID to lower case and keeps the goal verbatim", () => {
    const [decoded] = workstreamListFromWire({ workstreams: [workstream] });
    expect(decoded.id).toBe(workstream.id.toLowerCase());
    expect(decoded.channelId).toBe(workstream.channelId.toLowerCase());
    expect(decoded.rootMessageId).toBe(workstream.rootMessageId.toLowerCase());
    expect(decoded.createdByMemberId).toBe(
      workstream.createdByMemberId.toLowerCase()
    );
    expect(decoded.goal).toBe(workstream.goal);
    expect(decoded.runCount).toBe(3);
    expect(decoded.activeRunCount).toBe(1);
  });

  it("keeps an empty list distinct from a malformed one", () => {
    expect(workstreamListFromWire({ workstreams: [] })).toEqual([]);
    expect(() => workstreamListFromWire({ workstreams: null })).toThrow(
      WireShapeError
    );
    expect(() =>
      workstreamListFromWire({ workstreams: [{ ...workstream, runCount: "3" }] })
    ).toThrow(WireShapeError);
  });

  it("refuses a status outside the four the schema allows", () => {
    expect(() =>
      workstreamListFromWire({
        workstreams: [{ ...workstream, status: "archived" }],
      })
    ).toThrow(WireShapeError);
    for (const status of ["active", "paused", "done", "cancelled"]) {
      expect(
        workstreamListFromWire({ workstreams: [{ ...workstream, status }] })[0]
          .status
      ).toBe(status);
    }
  });

  it("carries a run's optional lineage and omits what the server left out", () => {
    const list = workstreamRunListFromWire({
      workstreamId: workstream.id,
      runs: [
        run,
        {
          ...run,
          id: "11111111-1111-7111-8111-111111111178",
          status: "running",
          resumedFromSessionId: run.id,
          endedAtMs: null,
          exitCode: null,
        },
      ],
    });
    expect(list.workstreamId).toBe(workstream.id.toLowerCase());
    expect(list.runs[0].endedAtMs).toBeUndefined();
    expect(list.runs[0].resumedFromSessionId).toBeUndefined();
    expect(list.runs[1].resumedFromSessionId).toBe(run.id.toLowerCase());
    expect(list.runs[1].endedAtMs).toBeUndefined();
    expect(list.runs[1].exitCode).toBeUndefined();
  });

  it("does not narrow a run status it has never heard of into a known one", () => {
    // The ledger owns this vocabulary and may grow it. A goal's whole history
    // failing to render because of one unnamed state would be a worse answer
    // than one row that says 상태 확인 필요.
    const [decoded] = workstreamRunListFromWire({
      workstreamId: workstream.id,
      runs: [{ ...run, status: "quarantined" }],
    }).runs;
    expect(decoded.status).toBe("quarantined");
  });

});
