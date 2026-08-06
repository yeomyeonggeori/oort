import { useEffect, useRef } from "react";
import type { WorkHost, WorkSession } from "@momo/core/lib/api";
import {
  HANDOFF_COPY,
  takeoverGate,
} from "@momo/core/features/work/sessionHandoff";
import { HostPicker } from "./HostPicker";
import { TakeoverDisclosure } from "./TakeoverDisclosure";

// =============================================================================
// 인수 블록 — 하나의 act, 하나의 구현 (ADR-0154 D3, #1137).
//
// 이 파일이 있는 이유는 이 티켓이 고치는 결함과 같은 종류다. HostPicker 주석이
// 이미 그 논증을 해 두었다: "두 표면이 같은 act를 제안한다 … 그런데 컨트롤은 두
// 벌이었다 … 두 번째 구현이 아니라 두 번째 호출자여야 한다." 그 규율을 픽커
// 한 칸에서 멈추면, 픽커를 감싸는 **문장들**이 다시 두 벌이 된다 — 실제로
// 그랬다: 작업 세션 패널과 작업 흐름 상세가 "Git 계보만…" 두 줄을 각자 들고
// 있었고, 둘 다 틀린 채로 같이 늙었다.
//
// 그래서 인수가 사람에게 보여야 하는 것 전부 — 무엇을 하는지(lead), 무엇이
// 넘어오고 무엇이 안 넘어오는지(고지), 지금 할 수 있는지(사전조건), 못 했으면
// 무엇을 하면 되는지(오류) — 가 이 한 컴포넌트에 있다. 상태는 없다: 어느 행의
// 폼이 열려 있는지, 어느 호스트로 요청이 나가 있는지는 호출자마다 다르고, 그것을
// 여기로 들이면 이 컴포넌트가 목록의 사정을 알아야 한다.
// =============================================================================

export function TakeoverBlock({
  session,
  hosts,
  targets,
  busyHostId,
  error,
  onPick,
  domId,
  labelId,
  testId,
}: {
  session: WorkSession;
  hosts: readonly WorkHost[] | undefined;
  /** 자격 있는 대상. 코어 `takeoverTargets`가 고른 것 그대로 넘긴다. */
  targets: readonly WorkHost[];
  busyHostId: string | null;
  error: string | null;
  onPick: (hostId: string) => void;
  domId: string;
  labelId: string;
  testId: string;
}) {
  const gate = takeoverGate(session, hosts, targets);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // 실패한 인수의 포커스 복구 (2R H1). 확정 버튼은 진행 중에도 enabled라 대개
  // 그대로 남아 있고, 그러면 사람이 그것을 쥔 채다 — 빼앗지 않는다. 자격
  // 호스트가 마지막 하나였고 그 사이에 사라졌다면 폼째로 언마운트되고 포커스가
  // <body>로 떨어지는데, 그때만 오류 문장이 받는다.
  useEffect(() => {
    if (error === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  return (
    // 이 블록은 호출자에서 가장 긴 한국어 산문을 담는다. 어절에서 끊는 규칙은 이
    // 컨테이너가 갖고(word-break는 상속된다), 긴 토큰을 받아내는 break-words는 각
    // 문단이 갖는다 — 한 엘리먼트에 함께 두면 tailwind-merge가 하나를 지운다
    // (MOMO-676 M-5). 261px 실측에서 이 규칙이 빠진 쪽의 `확인한`이 음절에서
    // 쪼개졌다(2R M5).
    <div
      className="mt-2 break-keep rounded-md border border-line bg-surface-raised px-3 py-2"
      data-testid={testId}
    >
      <p className="break-words text-meta text-ink-muted">
        {HANDOFF_COPY.takeover.lead}
      </p>
      {/* 부분 복원 고지. 「Git 계보만 이어집니다」를 두 목록으로 바꾼 이유는 그
          문장이 틀렸기 때문이다 — 실제로 이어지는 것은 스레드이고, git 계보는 이
          원장이 아예 모르는 것이다(TakeoverDisclosure 머리말). */}
      <TakeoverDisclosure testId={`${testId}-disclosure`} />
      {error !== null && (
        <p
          ref={errorRef}
          tabIndex={-1}
          className="mt-2 break-words text-meta text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          role="alert"
          data-testid={`${testId}-error`}
        >
          {error}
        </p>
      )}
      {/* 사전조건이 안 서면 픽커 자리에 **무엇을 하면 되는지**가 온다. 문구는
          코어가 정한다 — 「온라인인 다른 호스트가 없습니다」로 끝나던 앞 판은
          상태만 말하고 사람을 세워 뒀다(ADR-0154 D3). */}
      {!gate.canTakeover ? (
        <p
          className="mt-2 break-words text-meta text-ink-muted"
          data-testid={`${testId}-blocked`}
        >
          {gate.blockedCopy}
        </p>
      ) : (
        // 작업 흐름 상세의 같은 동선과 같은 컨트롤이다(HostPicker). 두 표면이
        // 제안하는 act가 같은데 컨트롤만 두 벌로 두면 같은 약속이 두 가지 무게와
        // 두 가지 폭으로 보인다.
        <HostPicker
          id={domId}
          labelId={labelId}
          copy={{
            group: "인수할 호스트",
            confirm: HANDOFF_COPY.takeover.button,
            action: (name) => `${name}에서 인수`,
            busy: (name) => `${name}에서 인수하는 중`,
          }}
          targets={targets}
          busyHostId={busyHostId}
          onPick={onPick}
          selectTestId="work-session-resume-host-select"
          confirmTestId="work-session-resume-confirm"
        />
      )}
    </div>
  );
}
