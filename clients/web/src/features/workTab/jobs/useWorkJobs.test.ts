import { describe, expect, it } from "vitest";
import { MAX_TEAM_BOARD_CHANNELS } from "@/features/workTab/teamBoard/useTeamBoard";
import { sharedRow } from "../teamBoard/teamBoardFixtures";
import { WORK_JOBS_POLL_MS, workJobsPollMs } from "./useWorkJobs";

// 「작업」 목록의 박자 (#5640): 실시간이 끊겼을 때만 60초다. 듣지 못하는 집 채널이 있으면(레일 상한 초과) 실시간이 있어도 박자를 지킨다.

const rowsIn = (channels: number) =>
  Array.from({ length: channels }, (_, i) =>
    sharedRow({
      sessionId: `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
      homeChannel: { id: `00000000-0000-7000-8001-${String(i).padStart(12, "0")}`, name: `ch-${i}` },
    })
  );

describe("작업 목록 박자 (#5640)", () => {
  it("실시간이 붙어 있고 모든 집 채널을 들으면 박자가 없다", () => {
    expect(workJobsPollMs(true, rowsIn(3))).toBe(false);
    expect(workJobsPollMs(true, [])).toBe(false);
    expect(workJobsPollMs(true, rowsIn(MAX_TEAM_BOARD_CHANNELS))).toBe(false);
  });

  it("실시간이 끊기면(연결 중 포함) 60초 박자다", () => {
    expect(workJobsPollMs(false, rowsIn(3))).toBe(WORK_JOBS_POLL_MS);
    expect(WORK_JOBS_POLL_MS).toBe(60_000);
  });

  it("집 채널이 레일 상한을 넘으면 실시간이 있어도 60초 박자다", () => {
    expect(workJobsPollMs(true, rowsIn(MAX_TEAM_BOARD_CHANNELS + 1))).toBe(WORK_JOBS_POLL_MS);
  });
});
