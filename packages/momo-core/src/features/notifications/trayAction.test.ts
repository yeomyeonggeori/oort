import { describe, expect, it } from "vitest";
import { readTrayAction, TRAY_ACTION, TRAY_ROW_ID } from "./trayAction";

describe("readTrayAction (#5193)", () => {
  // 셸의 `TrayAction` 직렬화(`tray.rs`의 `the_event_payload_is_the_one_the_page_reads`)가 적는 글자 그대로.
  it("어휘는 셸이 보내는 글자 그대로다", () => {
    expect(TRAY_ACTION).toEqual({
      newMessage: "new-message",
      run: "run",
      readAll: "read-all",
      windowHidden: "window-hidden",
    });
  });

  it("새 메시지·모두 읽음·창 치움과, 줄 id가 있는 작업 선택만 통과한다", () => {
    expect(readTrayAction({ action: "new-message" })).toEqual({ action: "new-message" });
    expect(readTrayAction({ action: "read-all" })).toEqual({ action: "read-all" });
    expect(readTrayAction({ action: "window-hidden" })).toEqual({ action: "window-hidden" });
    expect(readTrayAction({ action: "run", id: "12" })).toEqual({ action: "run", id: "12" });
    expect(readTrayAction({ action: "run", id: "job_7-x" })).toEqual({ action: "run", id: "job_7-x" });
    expect(readTrayAction({ action: "run", id: "x".repeat(64) })).not.toBeNull();
  });

  it("모르는 모양은 모두 null이다", () => {
    for (const bad of [
      null,
      undefined,
      "run",
      "new-message",
      42,
      [],
      {},
      { action: "open" },
      { action: "run" },
      { action: "run", id: "" },
      { action: "run", id: 7 },
      { action: "run", id: "a b" },
      { action: "run", id: "a.b" },
      { action: "run", id: "../../settings" },
      { action: "run", id: "x".repeat(65) },
      { action: "Run", id: "0" },
      { action: "readAll" },
      { action: "Read-All" },
      { action: "window_hidden" },
    ]) {
      expect(readTrayAction(bad)).toBeNull();
    }
  });

  it("줄 id 모양은 셸과 같다", () => {
    expect(TRAY_ROW_ID.test("0")).toBe(true);
    expect(TRAY_ROW_ID.test("a.b")).toBe(false);
  });
});
