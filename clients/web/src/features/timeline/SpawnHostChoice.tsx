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
// 승인 카드의 호스트 선택기 (ADR-0125 D6-A, 이슈 1114).
//
// 스폰 승인은 「해도 되나」와 「어디서 하나」를 함께 묻는다. 이 컴포넌트는 두 번째
// 질문만 그리고, 결정은 그대로 `ApprovalActions`의 2단 무장이 진다 — 승인 버튼
// 옆에 두 번째 확정 버튼을 세우지 않는다.
//
// ## 왜 `features/work/HostPicker`를 세 번째로 부르지 않았나 (계획 이탈)
//
// 이슈 1114의 원문은 "HostPicker 3번째 호출자"였고, 실제로 그 컨트롤이 이미 두
// 표면을 지고 있다(작업 세션 패널의 인수 · 작업 흐름 상세의 인수). 그것을 쓰지 않은 이유는
// 취향이 아니라 이 표면이 그 컨트롤과 **다른 계약**을 갖기 때문이고, 셋 다 그 파일
// 자신의 머리말이 세운 규칙에서 나온다:
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
// ## 자 (measure)
//
// `max-w-pane-lg`는 에이전트 카드가 이미 쓰는 그 자다(640px, "a card is not a
// banner"). 인박스 행에서 이 그룹은 목록 폭을 통째로 물려받는데, 1280 뷰포트에서
// 그러면 고른 줄의 `bg-accent-soft` 띠가 **1005px**이 되어 승인 확정 버튼(105px)을
// 강조에서 이긴다(design-review H2 실측). 27인치에서는 그 띠가 계속 자란다.
//
// 세로도 같은 이유로 `max-h-pane`이다: 후보 수에 상한이 없으므로(등록 호스트가 열
// 대인 워크스페이스) 목록이 아니라 **상자**가 한계를 갖고, 넘치면 그 안에서
// 스크롤한다. 줄을 잘라내는 쪽은 고르지 않았다 — 자격 없는 호스트를 숨기지 않는
// 것이 이 배치의 논점인데, 넘친다고 잘라내면 같은 일을 자리 부족이라는 이름으로
// 하게 된다.
//
// ## 잠금 (`locked`)
//
// 무장하면 라디오가 통째로 잠긴다. `<fieldset disabled>` 한 줄로 — 입력마다
// disabled를 계산하면 언젠가 한 줄이 빠진다. 이것은 tokens §5b가 말하는 "진짜로
// 할 수 없는 것"이 맞다: 확정 문장이 이미 목적지를 말했고, 그 문장 아래에서
// 목적지가 바뀌면 사람이 읽은 문장과 나가는 요청이 달라진다.
//
// **그런데 `fieldset`은 `<label>`을 잠그지 못한다** (design-review B1). label은 폼
// 컨트롤이 아니라서 `:hover`도 포인터 커서도 그대로 살아 있었고, 확정 화면에서
// 줄이 마우스 밑에서 밝아지며 "누르라"고 말한 뒤 클릭을 조용히 삼켰다. 그래서
// 커서·hover·글자색이 전부 `locked`를 읽는다: **잠긴 것은 누르기 전에 보여야 한다.**
// =============================================================================

export function SpawnHostChoice({
  plan,
  pickedHostId,
  onPick,
  locked,
  blockedId,
  testIdPrefix,
}: {
  plan: SpawnExecutionPlan;
  /** 지금 찍혀 있는 호스트. 자격 후보가 없으면 `null`. */
  pickedHostId: string | null;
  onPick: (hostId: string) => void;
  /** 결정이 무장했거나 전송 중이다 — 목적지를 더 이상 바꿀 수 없다. */
  locked: boolean;
  /**
   * 「고를 것이 없다」 문장의 id. 승인 버튼이 `aria-describedby`로 되짚는다 —
   * 그 버튼이 왜 아무 일도 하지 않는지는 화면에도, 스크린리더에도 있어야 한다.
   */
  blockedId: string;
  testIdPrefix: string;
}) {
  const groupId = useId();
  const gate = spawnHostGate(plan);

  return (
    <fieldset
      className="flex max-w-pane-lg flex-col gap-1 pb-2"
      disabled={locked}
      data-testid={`${testIdPrefix}-host-group`}
      // 순수 테스트 훅이다. 잠금의 **모습**은 아래 클래스들이 `locked`를 직접
      // 읽어 만든다(B1) — 이 속성에 걸린 CSS 규칙은 없고, 있어서도 안 된다.
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
        // 옵션마다 상자를 두르지 않는다. 행마다 카드는 web-card AI-tell이고
        // 밀도를 잡아먹는다(SettingsFields와 같은 관용구).
        <div className="flex max-h-pane flex-col overflow-y-auto rounded-md border border-line">
          {plan.candidates.map((candidate) => {
            const checked = candidate.hostId === pickedHostId;
            /** 지금 이 줄을 누를 수 있는가 — 자격과 잠금을 **둘 다** 읽는다. */
            const live = candidate.selectable && !locked;
            const tier = tierLabel(candidate.tier);
            const inputId = `${groupId}-${candidate.hostId}`;
            return (
              <label
                key={candidate.hostId}
                htmlFor={inputId}
                className={cn(
                  "flex min-w-0 items-center gap-2 border-b border-line p-2 last:border-b-0",
                  // 커서와 hover는 `selectable`이 아니라 **지금 누를 수 있는가**를
                  // 읽는다. 잠긴 줄이 마우스 밑에서 밝아지면 그것은 클릭을 권한
                  // 뒤 삼키는 것이다(B1).
                  live && "cursor-pointer hover:bg-surface-hover",
                  !candidate.selectable && "cursor-not-allowed",
                  candidate.selectable && locked && "cursor-default",
                  checked && candidate.selectable && "bg-accent-soft"
                )}
                data-testid={`${testIdPrefix}-host-option-${candidate.hostId}`}
                data-selectable={candidate.selectable ? "" : undefined}
                data-checked={checked ? "" : undefined}
              >
                {/* `mt-1`이 있었다. 행이 `items-start`였을 때의 잔재이고, 지금은
                    `items-center`라 라디오가 자기 라벨보다 2px 아래에 앉았다
                    (design-review M1 실측: 중심 384.5 대 380.5). */}
                <input
                  type="radio"
                  id={inputId}
                  name={groupId}
                  value={candidate.hostId}
                  checked={checked}
                  disabled={!candidate.selectable}
                  onChange={() => onPick(candidate.hostId)}
                  className="accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed"
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
                      // 못 고르는 줄도, 지금 잠긴 줄도 차분해진다. opacity로
                      // 낮추지 않는 이유는 사유("오프라인")까지 함께 읽기
                      // 어려워지기 때문이다 — 그 사유가 이 줄을 세워 둔 이유다.
                      live ? "text-ink" : "text-ink-muted"
                    )}
                  >
                    {candidateLabel(candidate)}
                  </span>
                  {tier !== null && (
                    // 이름이 이미 말하는 경우가 많다(「팀 VPS」). 그래도 두는
                    // 이유는 이름이 아무것도 말하지 않는 경우가 있기 때문이고
                    // (「build-01」), ADR-0125 D6-A의 3택이 묻는 것이 정확히 이
                    // 축이기 때문이다.
                    <span className="shrink-0 text-meta text-ink-muted">
                      {tier}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {gate.blockedCopy !== undefined && (
        // `role="status"`가 아니다 (design-review M5). 라이브 리전은 **바뀐** 내용을
        // 읽는데 이 문장은 첫 페인트부터 거기 있어서 아무것도 발화되지 않았다.
        // 대신 승인 버튼이 `aria-describedby`로 이 id를 되짚는다 — 그 버튼에 초점이
        // 닿는 순간 이유가 함께 읽힌다.
        <p
          id={blockedId}
          data-testid={`${testIdPrefix}-host-blocked`}
          className="pt-1 text-meta text-ink-muted"
        >
          {gate.blockedCopy}
        </p>
      )}
    </fieldset>
  );
}
