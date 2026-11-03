// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { draftFor, failUpload, type AttachmentDraft } from "@momo/core/features/attachments/model";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { AttachmentTray } from "./AttachmentTray";

// #5221: 올리기 실패의 이유를 상태 코드 대신 원인의 분류 문장으로 말한다. 502·503은 「파일 보관소가 연결돼 있지 않습니다」가
// 아니라 서버가 응답하지 않아서 올리지 못한 것이고, 칩에는 「다시 올리기」가 선다. 눈에 보이는 줄과 낭독이 같은 문장이다.

let locale: AppLocale;
beforeAll(async () => {
  locale = await koreanLocaleForTest();
});
afterEach(cleanup);

function failed(over: { issue: Parameters<typeof failUpload>[2]; cause?: Parameters<typeof failUpload>[3] }): AttachmentDraft[] {
  const list = [draftFor("a", { name: "보고서.pdf", mime: "application/pdf", sizeBytes: 2_400_000 })];
  return failUpload(list, "a", over.issue, over.cause);
}

function mount(drafts: AttachmentDraft[]) {
  const noop = vi.fn();
  render(
    <LocaleProvider locale={locale}>
      <AttachmentTray
        drafts={drafts}
        rejected={0}
        folders={0}
        onRemove={noop}
        onRetry={noop}
        onClear={noop}
        onAcknowledgeNotices={noop}
        returnFocus={noop}
      />
    </LocaleProvider>
  );
}

describe("AttachmentTray: 올리기 실패의 이유는 분류로 말한다", () => {
  // 지키는 것: 닿지 못한 실패는 원인의 문장을 쓰고, 보관소 문장도 상태 코드도 없다. 다시 올리기가 선다.
  it("오프라인·서버에 닿지 못함은 그 원인의 문장이고 다시 올리기가 선다", () => {
    for (const [cause, sentence] of [
      ["deviceOffline", "오프라인이라 올리지 못했어요"],
      ["serverUnreachable", "서버가 응답하지 않아 올리지 못했어요"],
    ] as const) {
      mount(failed({ issue: "unavailable", cause }));
      const status = screen.getByTestId("attachment-chip-status");
      expect(status.textContent).toBe(sentence);
      expect(status.textContent).not.toContain("보관소");
      expect(status.textContent).not.toMatch(/\d{3}/);
      expect(screen.queryByRole("button", { name: /다시/ })).not.toBeNull();
      cleanup();
    }
  });

  // 지키는 것: 원인이 없는 실패(서버가 직접 이름 붙인 거절)는 칩의 기존 문장이다. 우리 서버가 낸 보관소 미연결은 그대로 말한다.
  it("원인이 없으면 이유의 기존 문장을 쓴다: 서버가 직접 낸 보관소 미연결은 그대로", () => {
    mount(failed({ issue: "no-archive" }));
    expect(screen.getByTestId("attachment-chip-status").textContent).toContain("파일 보관소가 연결돼 있지 않습니다");
    cleanup();
    mount(failed({ issue: "unavailable" }));
    expect(screen.getByTestId("attachment-chip-status").textContent).toBe("업로드 실패");
  });
});
