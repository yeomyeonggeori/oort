import { useId } from "react";
import { cn } from "@/design/lib/cn";
import type { SpawnExecutionPlan } from "@momo/core/lib/executionPlan";
import {
  candidateLabel,
  HOST_CHOICE_LABEL,
  spawnHostGate,
  tierLabel,
} from "@momo/core/features/timeline/spawnHostChoice";

// =============================================================================
// 승인 카드의 호스트 선택기 (ADR-0125 D6-A, 이슈 1114 클라 축).
//
// 스폰 승인은 「해도 되나」와 「어디서 하나」를 함께 묻는다. 이 컴포넌트는 두 번째
// 질문만 그리고, 결정은 그대로 `ApprovalActions`의 2단 무장이 진다 — 승인 버튼
// 옆에 두 번째 확정 버튼을 세우지 않는다.
//
// ## 왜 `features/work/HostPicker`를 세 번째로 부르지 않았나 (계획 이탈)
//
// 이슈 1114의 원문은 "HostPicker 3번째 호출자"였고, 실제로 그 컨트롤이 이미 두 표면을
// 지고 있다(작업 세션 재개 · 작업 흐름 이어받기). 그것을 쓰지 않은 이유는 취향이
// 아니라 이 표면이 그 컨트롤과 **다른 계약**을 갖기 때문이고, 셋 다 그 파일 자신의
// 머리말이 세운 규칙에서 나온다:
//
//  1. **HostPicker의 확정 버튼이 곧 실행이다** (`onPick(hostId)` → 재개 요청).
//     여기서 실행을 여는 것은 「승인 확정」이다. 그 둘을 한 카드에 세우면
//     `variant="default"` 채움 버튼이 둘이 되고, 그것은 그 파일이 v1에서 겪고
//     고친 결함(§8 "N개의 동급 채움은 아무것도 강조하지 않는다")을 되부른다.
//  2. **자격 없는 후보를 사유와 함께 세워야 한다.** HostPicker는 `<select>`이고,
//     닫힌 `<select>`는 고른 한 줄만 보여준다. 「낡은 맥 (오프라인)」·「momo Cloud
//     (준비 중)」은 메뉴를 열어야 보이는 각주가 되고, 그러면 서버가 자격 없는
//     호스트를 **숨기지 않고 싣기로 한 결정**(이슈 1132)이 화면에서 무효가 된다.
//     "왜 내 랩탑을 못 고르지"의 답이 클릭 뒤에 있으면 그건 답이 아니다.
//  3. **여기서 고르는 것은 `WorkHost`가 아니다.** HostPicker의 `targets`는
//     `WorkHost[]`(등록기 투영)이고, 이 카드가 가진 것은 승인이 그려진 시점에
//     **동결된** 후보 목록이다. 둘을 한 타입으로 합치면 라이브 투영과 스냅샷이
//     같은 칸에 들어가고, 그 순간 화면은 어느 쪽 시점의 사실을 말하는지 모른다.
//
// 그래서 형태는 `SettingsFields`의 라디오 그룹 관용구를 그대로 쓴다(테두리 하나 +
// 헤어라인 행). N중 택1은 플랫폼이 이미 가진 형태이고, 그 프리미티브는 여기서
// `<input type="radio">`다 — 손으로 그린 listbox가 아니다(design-taste-web §1).
//
// ## 잠금 (`locked`)
//
// 무장하면 라디오가 통째로 잠긴다. `<fieldset disabled>` 한 줄로 — 입력마다
// disabled를 계산하면 언젠가 한 줄이 빠진다. 이것은 tokens §5b가 말하는 "진짜로
// 할 수 없는 것"이 맞다: 확정 문장이 이미 목적지를 말했고, 그 문장 아래에서 목적지가
// 바뀌면 사람이 읽은 문장과 나가는 요청이 달라진다.
// =============================================================================

export function SpawnHostChoice({
  plan,
  pickedHostId,
  onPick,
  locked,
  testIdPrefix,
}: {
  plan: SpawnExecutionPlan;
  /** 지금 찍혀 있는 호스트. 자격 후보가 없으면 `null`. */
  pickedHostId: string | null;
  onPick: (hostId: string) => void;
  /** 결정이 무장했거나 전송 중이다 — 목적지를 더 이상 바꿀 수 없다. */
  locked: boolean;
  testIdPrefix: string;
}) {
  const groupId = useId();
  const gate = spawnHostGate(plan);

  return (
    <fieldset
      className="flex flex-col gap-1 pb-2"
      disabled={locked}
      data-testid={`${testIdPrefix}-host-group`}
      data-locked={locked ? "" : undefined}
    >
      {/* 눈에 보이는 라벨이다. 스크린리더 전용 `aria-label`로 두면 시각 사용자는
          라디오 목록이 무엇을 묻는지 모른 채 기계 이름 서너 개만 본다 —
          HostPicker가 v1에서 같은 결함을 고쳤다. */}
      <legend className="pb-1 text-meta text-ink-muted">
        {HOST_CHOICE_LABEL}
      </legend>
      {/* 후보가 0이면 상자 자체를 세우지 않는다. 빈 테두리는 「목록이 로딩 중」
          으로 읽히는데, 실제로 일어난 일은 **등록된 호스트가 없다**이고 그것은
          아래 문장이 말한다. 서버는 이 경우에도 `host_candidates` 키를 실으므로
          카드는 여전히 호스트를 묻는 카드다(`offersHostChoice` 주석 참고). */}
      {plan.candidates.length > 0 && (
      <div className="flex flex-col overflow-hidden rounded-md border border-line">
        {plan.candidates.map((candidate) => {
          const checked = candidate.hostId === pickedHostId;
          const tier = tierLabel(candidate.tier);
          const inputId = `${groupId}-${candidate.hostId}`;
          return (
            <label
              key={candidate.hostId}
              htmlFor={inputId}
              className={cn(
                "flex min-w-0 items-center gap-2 border-b border-line p-2 last:border-b-0",
                candidate.selectable
                  ? "cursor-pointer"
                  : // 못 고르는 줄은 흐려지는 대신 **차분해진다**. opacity로 낮추면
                    // 사유("오프라인")까지 함께 읽기 어려워지는데, 그 사유가 이
                    // 줄을 세워 둔 유일한 이유다.
                    "cursor-not-allowed",
                checked && candidate.selectable
                  ? "bg-accent-soft"
                  : candidate.selectable
                    ? "hover:bg-surface-hover"
                    : null
              )}
              data-testid={`${testIdPrefix}-host-option-${candidate.hostId}`}
              data-selectable={candidate.selectable ? "" : undefined}
              data-checked={checked ? "" : undefined}
            >
              <input
                type="radio"
                id={inputId}
                name={groupId}
                value={candidate.hostId}
                checked={checked}
                disabled={!candidate.selectable}
                onChange={() => onPick(candidate.hostId)}
                className="mt-1 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed"
                data-testid={`${testIdPrefix}-host-radio-${candidate.hostId}`}
              />
              {/* 한 줄이다. tier를 자기 줄에 내리면 네 후보가 인박스 행 안에서
                  360px을 먹고(실측), 결정에 필요한 나머지 사실 — 누가·언제까지·
                  되돌릴 수 있는지 — 이 화면 밖으로 밀린다. 이 표면의 밀도는
                  7/10이고 픽커는 그 예산 안에 들어와야 한다. */}
              <span className="flex min-w-0 flex-wrap items-baseline gap-2">
                {/* 사유는 이름과 **같은 조각**에 붙는다(`candidateLabel`). 떼면
                    목록을 훑는 눈에게는 그냥 흐린 이름 하나다. */}
                <span
                  className={cn(
                    "break-keep text-body",
                    candidate.selectable ? "text-ink" : "text-ink-muted"
                  )}
                >
                  {candidateLabel(candidate)}
                </span>
                {tier !== null && (
                  // 이름이 이미 말하는 경우가 많다(「팀 VPS」). 그래도 두는 이유는
                  // 이름이 아무것도 말하지 않는 경우가 있기 때문이다(「build-01」),
                  // 그리고 ADR-0125 D6-A의 3택이 묻는 것이 정확히 이 축이다.
                  <span className="shrink-0 text-meta text-ink-muted">{tier}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      )}
      {gate.blockedCopy !== undefined && (
        // 사고가 아니라 상태다 — 빨간 alert이 아니라 조용한 안내로 끼어들지 않고
        // 선다. 무엇이 이것을 바꾸는지까지 말하는 것은 코어의 문장이 한다.
        <p
          role="status"
          data-testid={`${testIdPrefix}-host-blocked`}
          className="pt-1 text-meta text-ink-muted"
        >
          {gate.blockedCopy}
        </p>
      )}
    </fieldset>
  );
}
