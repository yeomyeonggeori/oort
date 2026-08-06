import {
  TAKEOVER_DISCLOSURE_HEADLINE,
  TAKEOVER_FRESH,
  TAKEOVER_FRESH_LABEL,
  TAKEOVER_RESTORED,
  TAKEOVER_RESTORED_LABEL,
} from "@momo/core/features/work/sessionHandoff";

// =============================================================================
// 부분 복원 고지 (ADR-0154 D3, #1137).
//
// 앞 판은 두 문장이었다:
//
//   "Git 계보만 새 호스트로 이어집니다."
//   "이전 호스트의 터미널 상태와 미커밋 변경은 옮겨지지 않습니다."
//
// 두 번째 줄은 참이었지만 첫 줄이 틀렸다 — 실제로 이어지는 것은 「Git 계보」가
// 아니라 **스레드**다. 서버는 인수된 세션에 원본의 `root_message_id` 를 그대로
// 싣고(`create_resumed_work_session_in_tx` 실측), 그래서 지금까지의 진행 내역이
// 같은 자리에 이어 쌓인다. 「Git 계보」는 이 원장이 아예 모르는 것이다: 세션 행에
// repo/branch/worktree 칼럼이 없고, 서버가 git 상태를 읽는 코드도 없다.
//
// 그래서 이 컴포넌트는 산문 두 줄이 아니라 **두 목록**이다. 산문은 읽는 사람이
// 자기 미커밋 변경이 「계보」인지 「터미널 상태」인지 스스로 판정하게 만들었고,
// 그 판정이 틀리면 잃는 것은 그 사람의 오늘 작업이다. 목록은 그 판정을 대신
// 해 준다.
//
// 두 목록을 **나란히 세우지 않는다**(위/아래). 320px 작업 세션 pane 이 이
// 컴포넌트의 좁은 쪽 호출자이고, 거기서 2열은 각 열을 130px 로 만들어 모든
// 항목을 서너 줄로 접는다. 순서에도 이유가 있다: 얻는 것이 먼저고 잃는 것이
// 나중이다 — 마지막에 읽은 것이 결정 버튼 바로 위에 남는다.
// =============================================================================

function Facts({
  label,
  items,
  tone,
  testId,
}: {
  label: string;
  items: readonly string[];
  tone: "ok" | "warn";
  testId: string;
}) {
  return (
    <div className="mt-1">
      <p
        className={
          tone === "ok"
            ? "text-meta text-ok"
            : "text-meta text-warn"
        }
      >
        {label}
      </p>
      {/* `list-disc` 가 아니라 가운뎃점을 쓰는 이유: 이 레포의 다른 목록이
          그렇고(작업 세션 행의 메타 줄), 마커 들여쓰기가 320px 에서 본문 폭을
          한 번 더 깎는다. */}
      <ul className="break-keep" data-testid={testId}>
        {items.map((item) => (
          <li
            key={item}
            className="flex gap-1 break-words text-meta text-ink-muted"
          >
            <span aria-hidden="true" className="shrink-0">
              ·
            </span>
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TakeoverDisclosure({ testId }: { testId?: string }) {
  return (
    <div data-testid={testId} className="break-keep">
      <p className="break-words text-meta text-ink">
        {TAKEOVER_DISCLOSURE_HEADLINE}
      </p>
      <Facts
        label={TAKEOVER_RESTORED_LABEL}
        items={TAKEOVER_RESTORED}
        tone="ok"
        testId="takeover-restored"
      />
      <Facts
        label={TAKEOVER_FRESH_LABEL}
        items={TAKEOVER_FRESH}
        tone="warn"
        testId="takeover-fresh"
      />
    </div>
  );
}
