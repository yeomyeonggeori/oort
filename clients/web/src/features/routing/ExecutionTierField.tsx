import { useId } from "react";
import { Cloud, Laptop, Server } from "lucide-react";
import { cn } from "@/design/lib/cn";
import {
  EXECUTION_TIER_LABEL,
  type ExecutionTierAxis,
  type ExecutionTierKey,
} from "@momo/core/features/routing/tierAxis";

// =============================================================================
// 라우팅 스트립의 실행 위치 축 (CRUN-1 / 이슈 1382) — Cursor 「Run on」의 번역.
//
// ## 왜 메뉴가 아니라 라디오 목록인가
//
// 이슈가 서브메뉴를 금지했고, 그 금지에는 이 표면의 이유가 있다. 닫힌 메뉴는 고른
// 한 줄만 보여 주므로 「T3 · 클라우드 (등록된 호스트가 없습니다)」는 메뉴를 열어야
// 보이는 각주가 된다. 그러면 부적격 호스트를 **숨기지 않고 사유와 함께 싣기로 한
// 결정**(#1132, SpawnHostChoice)이 화면에서 무효가 된다. "왜 내 랩탑에서 못
// 돌리지"의 답이 클릭 뒤에 있으면 그건 답이 아니다.
//
// 그래서 형태는 SpawnHostChoice와 같은 관용구다: 테두리 하나 + 헤어라인 행, 손으로
// 그린 listbox가 아니라 `<input type="radio">`(design-taste-web §1). 행마다 카드를
// 두르지 않는 것도 같은 이유다(web-card AI-tell).
//
// ## 지금은 전부 잠겨 있다
//
// 메시지 한 건에 실행 위치를 실을 전선이 아직 없다. `routing` 블록의 허용 키는 두
// 세대 모두 model·effort 둘뿐이고(`ROUTING_KEYS`, openapi `RunRoutingInput`은
// `additionalProperties: false`), `SendMessageRequest`에도 호스트를 받는 키가 없다.
// 그래서 이 상자는 **지금 무엇이 적용되는지를 보여 주는 자리**이고, 그 사실이 상자
// 아래 한 문장으로 적혀 있다(`axis.overrideReason`). 없는 계약을 지어내 400을
// 부르는 대신, 축을 끝까지 그려 두고 전선이 오면 `locked`만 풀면 되게 둔다.
//
// `fieldset disabled` 한 줄로 잠근다 — 입력마다 disabled를 계산하면 언젠가 한 줄이
// 빠진다. **그런데 `fieldset`은 `<label>`을 잠그지 못한다**(SpawnHostChoice의
// design-review B1): label은 폼 컨트롤이 아니라서 hover도 포인터 커서도 그대로
// 살아 있다. 그래서 커서와 hover가 잠금을 직접 읽는다. 잠긴 것은 누르기 전에
// 보여야 한다.
//
// ## 밀도
//
// 컴포저의 펼침 상자 안이라 행 여백은 `px-2 py-1`이다. 승인 카드의 같은 관용구는
// `p-2`인데, 거기는 카드 한 장이 화면의 주인공이고 여기는 이미 두 상자(모델·강도)가
// 위에 서 있는 4행짜리 부속이다. `max-w-pane-lg`는 그 두 상자가 쓰는 자 그대로다.
// =============================================================================

const TIER_ICON: Readonly<Record<ExecutionTierKey, typeof Laptop>> = {
  t1: Laptop,
  t2: Server,
  t3: Cloud,
};

/**
 * 한 줄. 잠겨 있으므로 라디오는 표시이지 컨트롤이 아니지만, 그래도 라디오다:
 * 전선이 오면 이 목록이 그대로 살아나야 하고, 그때 N중 택1의 프리미티브는
 * 플랫폼이 이미 가지고 있다.
 */
function TierRow({
  groupId,
  value,
  label,
  reason,
  checked,
  eligible,
  icon,
  testId,
}: {
  groupId: string;
  value: string;
  label: string;
  reason: string | null;
  checked: boolean;
  /** 여기서 돌 수 있는 곳인가. 지금 이 상자가 실제로 전하는 정보다. */
  eligible: boolean;
  icon?: typeof Laptop;
  testId: string;
}) {
  const inputId = `${groupId}-${value}`;
  const Icon = icon;
  return (
    <label
      htmlFor={inputId}
      // hover도 포인터 커서도 없다. 이 줄은 지금 누를 수 없고, 그 사실은 마우스가
      // 올라가기 전에 보여야 한다.
      className="flex min-w-0 cursor-not-allowed items-center gap-2 border-b border-line px-2 py-1 last:border-b-0"
      data-testid={testId}
      data-checked={checked ? "" : undefined}
      data-eligible={reason === null ? "" : undefined}
    >
      <input
        type="radio"
        id={inputId}
        name={groupId}
        value={value}
        checked={checked}
        // `disabled`가 붙어 있으므로 React는 onChange 없는 `checked`를 경고하지
        // 않는다. 라디오에 `readOnly`를 다는 쪽은 스펙상 아무 뜻도 없는 속성이라
        // 쓰지 않는다.
        disabled
        className="accent-accent focus-visible:focus-ring disabled:cursor-not-allowed"
      />
      {/* 아이콘이 없는 줄(어느 티어인지 아직 모르는 상속)도 자리는 남긴다. 자리가
          없으면 그 줄만 왼쪽으로 4px 튀어나와 목록의 왼쪽 모서리가 들쭉날쭉해진다. */}
      {Icon ? (
        <Icon aria-hidden="true" className="size-3 shrink-0 text-ink-muted" />
      ) : (
        <span aria-hidden="true" className="size-3 shrink-0" />
      )}
      {/* 사유는 이름과 **같은 조각**에 붙는다. 떼어 놓으면 목록을 훑는 눈에게는
          그냥 흐린 이름 하나다(SpawnHostChoice `candidateLabel`과 같은 규율). */}
      <span className="flex min-w-0 flex-wrap items-baseline gap-2">
        <span
          className={cn(
            "shrink-0 break-keep text-meta",
            // 잠겨 있어도 「여기서는 돌 수 있다」와 「여기서는 못 돈다」는 다른
            // 사실이고, 지금 이 상자가 전하는 것이 정확히 그 차이다. 사유가 붙은
            // 줄만 차분해진다 — opacity로 낮추지 않는 이유는 그 사유까지 함께
            // 읽기 어려워지기 때문이다.
            checked || eligible ? "text-ink" : "text-ink-muted"
          )}
        >
          {label}
        </span>
        {reason && (
          <span className="min-w-0 text-meta text-ink-muted">{reason}</span>
        )}
      </span>
    </label>
  );
}

export function ExecutionTierField({
  idPrefix,
  axis,
}: {
  idPrefix: string;
  axis: ExecutionTierAxis;
}) {
  const groupId = useId();
  const inheritSentenceId = `${idPrefix}-tier-inherit`;
  const reasonId = `${idPrefix}-tier-reason`;

  return (
    <fieldset
      className="flex min-w-0 max-w-pane-lg flex-col"
      disabled={!axis.overrideSupported}
      // 잠긴 이유는 상자를 짚은 사람에게 닿아야 한다. 화면 어딘가에 적혀 있는
      // 것만으로는 포커스가 상자에 있는 사람에게 전달되지 않는다.
      aria-describedby={
        axis.overrideReason === null
          ? inheritSentenceId
          : `${inheritSentenceId} ${reasonId}`
      }
      data-testid={`${idPrefix}-tier`}
    >
      {/* 눈에 보이는 라벨이다. 모델·강도 상자의 `<label>`과 같은 자리, 같은 크기. */}
      <legend className="pb-1 text-meta text-ink-muted">
        {EXECUTION_TIER_LABEL}
      </legend>
      <div className="flex flex-col rounded-md border border-line">
        {/* 첫 줄은 언제나 상속이고 언제나 찍혀 있다. 이 줄의 기본 내용은
            오버라이드가 아니라 상속이라는 MentionRoutingBar의 결정 그대로다. */}
        <TierRow
          groupId={groupId}
          value=""
          label={axis.inherited.label}
          reason={null}
          checked
          eligible
          icon={axis.inherited.key === null ? undefined : TIER_ICON[axis.inherited.key]}
          testId={`${idPrefix}-tier-inherit-row`}
        />
        {axis.options.map((option) => (
          <TierRow
            key={option.key}
            groupId={groupId}
            value={option.key}
            label={option.label}
            reason={option.reason}
            checked={false}
            eligible={option.eligible}
            icon={TIER_ICON[option.key]}
            testId={`${idPrefix}-tier-option-${option.key}`}
          />
        ))}
      </div>
      {/* 상속이 실제로 무슨 일을 일으키는지. 「상속」이라는 단어만으로는 아무것도
          말하지 않은 것이고, 그 병기가 이 줄의 원래 문법이다(D3 상속 실제값 병기). */}
      <p
        id={inheritSentenceId}
        className="mt-2 text-meta text-ink-muted"
        data-testid={`${idPrefix}-tier-inherit-sentence`}
      >
        {axis.inherited.sentence}
      </p>
      {axis.overrideReason && (
        <p
          id={reasonId}
          className="mt-2 text-meta text-ink-muted"
          data-testid={`${idPrefix}-tier-reason`}
        >
          {axis.overrideReason}
        </p>
      )}
    </fieldset>
  );
}
