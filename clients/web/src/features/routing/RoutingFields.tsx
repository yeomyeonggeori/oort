import { cn } from "@/design/lib/cn";
import { Select } from "@/design/ui/select";
import {
  applyModelChange,
  effectiveModel,
  effortLabel,
  effortsForModel,
  supportsEffort,
  type EffortTable,
  type RoutingDraft,
} from "./routingModel";

// =============================================================================
// 모델 + 추론 강도, 한 쌍 (ADR-0134 D2·D3).
//
// 에이전트 프로필 다이얼로그와 컴포저 1회 오버라이드가 같은 컴포넌트를 쓴다.
// 두 화면이 상속을 다르게 쓰면 사람이 같은 단어를 두 가지로 배우게 되고,
// 자동 클리어 규칙도 두 벌이 되어 한쪽만 고쳐지는 순간이 온다.
//
// 상속은 첫 번째 옵션이고 빈 문자열이며, 라벨에 실제로 적용될 값이 함께 적힌다
// (D3 "상속 (실제값 병기)"). 그 문구는 화면마다 상속의 상대가 달라서
// (프로필 편집은 에이전트 기본, 컴포저는 프로필) 위에서 내려받는다.
//
// 모델을 바꾸면 강도 유효값이 바뀐다. 새 모델이 지금 강도를 받지 않으면
// applyModelChange가 강도를 상속으로 비우고 무엇을 비웠는지 돌려주며, 이 컴포넌트
// 는 그 문장을 강도 상자 밑에 붙인다. 조용히 사라지는 값은 없다.
//
// **두 상자는 따로 잠긴다**(R1 B2). 모델 축은 ADR-0131 D2라 모든 세대의 서버가
// 가지고 있고, 추론 강도 축은 ADR-0134 D2라 아직 없는 서버가 있다. 그 둘을 한
// 플래그로 묶으면 "강도 표가 없다"는 사실 하나가 모델 편집까지 꺼 버리고, 바로
// 아래 "지금 적용: 모델 hermes-fast" 줄과 정면으로 모순된다. 잠금도 사유도 축
// 단위다.
// =============================================================================

export function RoutingFields({
  idPrefix,
  table,
  models,
  inheritedModel,
  modelInheritLabel,
  effortInheritLabel,
  draft,
  onChange,
  /** 모델 상자를 잠근다. 잠갔으면 `modelDisabledReason`이 반드시 있다. */
  modelDisabled = false,
  modelDisabledReason = null,
  /** 강도 상자를 잠근다. 잠갔으면 `effortDisabledReason`이 반드시 있다. */
  effortDisabled = false,
  effortDisabledReason = null,
  /** 마지막 자동 클리어를 설명하는 **완성된 문장**. 없으면 null. */
  clearedNotice = null,
  /** 프로필에 저장돼 있지만 지금 모델에서 죽어 있는 강도 안내. */
  ignoredNotice = null,
  /**
   * `stack`은 다이얼로그(512px 패널에서 한 칸씩), `row`는 컴포저다. 컴포저에서
   * 세로로 쌓으면 1600px 창에서 모델 상자 하나가 1500px이 되는데, 모델 핸들은
   * 20자를 넘지 않으므로 그 폭은 전부 빈 곳이고 라벨과 값이 멀어진다
   * (tokens.md §4: 라벨에서 멀어진 값은 행이 아니라 배너로 읽힌다).
   */
  layout = "stack",
}: {
  idPrefix: string;
  /** 강도 유효값을 재는 자. 없으면 강도 축 자체를 모르는 서버다. */
  table: EffortTable | null;
  /** 모델 피커에 올릴 이름들. 호출자가 아는 출처를 합쳐서 만든다. */
  models: readonly string[];
  inheritedModel: string;
  modelInheritLabel: string;
  effortInheritLabel: string;
  draft: RoutingDraft;
  onChange: (next: RoutingDraft, clearedEffort: string | null) => void;
  modelDisabled?: boolean;
  modelDisabledReason?: string | null;
  effortDisabled?: boolean;
  effortDisabledReason?: string | null;
  clearedNotice?: string | null;
  ignoredNotice?: string | null;
  layout?: "stack" | "row";
}) {
  const modelId = `${idPrefix}-model`;
  const effortId = `${idPrefix}-effort`;
  const clearedId = `${idPrefix}-cleared-notice`;
  const ignoredId = `${idPrefix}-ignored-notice`;
  const modelReasonId = `${idPrefix}-model-reason`;
  const effortReasonId = `${idPrefix}-effort-reason`;

  const model = effectiveModel(draft, inheritedModel);
  const efforts = table ? effortsForModel(table, model).efforts : [];
  // 표가 없으면 고를 수 있는 강도가 하나도 없다. 그때는 서버가 준 것이 없다는
  // 사실 그대로 상속 하나만 남은 상자를 잠근다. 임의의 목록을 지어내면 서버가
  // 400으로 거절할 값을 사람에게 권하는 셈이 된다.
  const effortLocked = effortDisabled || table === null;
  const modelLocked = modelDisabled;

  function changeModel(value: string) {
    const next = value === "" ? null : value;
    // 표가 없으면 강도 유효값을 잴 수 없다. 그때는 모델만 갈아 끼우고 강도는
    // 건드리지 않는다(어차피 상자가 잠겨 있어 값은 상속뿐이다).
    if (!table) {
      onChange({ ...draft, model: next }, null);
      return;
    }
    const result = applyModelChange(table, draft, next, inheritedModel);
    onChange(result.draft, result.clearedEffort);
  }

  function changeEffort(value: string) {
    onChange({ ...draft, effort: value === "" ? null : value }, null);
  }

  // 지금 걸려 있는 값이 목록에 없으면 그 값을 목록에 되살려 놓는다.
  //
  // `<select>`는 일치하는 option이 없으면 첫 항목을 대신 보여 준다. 그래서 표를
  // 못 받은 서버에서는(목록이 비어 있다) 저장된 hermes-fast가 상자에서 "상속"
  // 으로 읽히고, 바로 밑의 "지금 적용" 줄과 정면으로 어긋났다(momowebqa 형상
  // 실측). 저장된 값을 화면이 임의로 다른 값처럼 보여 주는 것보다, 있는 그대로
  // 두고 필요할 때 안내하는 쪽이 정직하다.
  const orphanModel =
    draft.model !== null && !models.includes(draft.model) ? draft.model : null;
  const orphanEffort =
    draft.effort !== null && !efforts.includes(draft.effort) ? draft.effort : null;
  // 유효값을 아는 경우에만 "쓸 수 없음"이라고 말한다. 표가 없으면 그 판정을 할
  // 근거 자체가 없다.
  const orphanEffortUnusable =
    orphanEffort !== null && table !== null && !supportsEffort(table, model, orphanEffort);

  const row = layout === "row";
  const fieldClass = row ? "flex min-w-0 flex-1 flex-col gap-1" : "flex min-w-0 flex-col gap-1";

  const modelReason = modelLocked ? modelDisabledReason : null;
  const effortReason = effortLocked ? effortDisabledReason : null;
  // 두 축이 같은 이유로 잠겼으면 문장도 하나다. 같은 말을 두 번 적으면 사람은
  // 두 개의 다른 문제가 있다고 읽는다.
  const sharedReason = modelReason !== null && modelReason === effortReason;

  // 잠긴 이유는 상자를 짚은 사람에게 닿아야 한다. 화면 아래 어딘가에 적혀 있는
  // 것만으로는 포커스가 상자에 있는 사람에게 전달되지 않는다(R1 M6).
  const describe = (...ids: (string | null)[]): string | undefined => {
    const present = ids.filter((id): id is string => id !== null);
    return present.length > 0 ? present.join(" ") : undefined;
  };

  return (
    <div className="flex flex-col">
      <div
        className={cn(
          row ? "flex max-w-pane-lg flex-wrap items-end gap-3" : "flex flex-col gap-3"
        )}
      >
        <div className={fieldClass}>
          <label htmlFor={modelId} className="text-meta text-ink-muted">
            모델
          </label>
          <Select
            id={modelId}
            value={draft.model ?? ""}
            disabled={modelLocked}
            onChange={(event) => changeModel(event.target.value)}
            aria-describedby={describe(modelReason ? modelReasonId : null)}
            data-testid={modelId}
            data-override={draft.model !== null ? "" : undefined}
          >
            <option value="">{modelInheritLabel}</option>
            {models.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            {orphanModel && <option value={orphanModel}>{orphanModel}</option>}
          </Select>
        </div>

        <div className={fieldClass}>
          <label htmlFor={effortId} className="text-meta text-ink-muted">
            추론 강도
          </label>
          <Select
            id={effortId}
            value={draft.effort ?? ""}
            disabled={effortLocked}
            onChange={(event) => changeEffort(event.target.value)}
            aria-describedby={describe(
              clearedNotice ? clearedId : null,
              ignoredNotice ? ignoredId : null,
              effortReason ? (sharedReason ? modelReasonId : effortReasonId) : null
            )}
            data-testid={effortId}
            data-override={draft.effort !== null ? "" : undefined}
          >
            <option value="">{effortInheritLabel}</option>
            {efforts.map((option) => (
              <option key={option} value={option}>
                {effortLabel(option)}
              </option>
            ))}
            {orphanEffort && (
              <option value={orphanEffort}>
                {effortLabel(orphanEffort)}
                {orphanEffortUnusable ? " (이 모델에서는 쓸 수 없음)" : ""}
              </option>
            )}
          </Select>
        </div>
      </div>

      {/* 안내는 상자 아래 한 줄씩, 폭을 나눠 쓰지 않는다. 문장은 두 칸으로
          쪼개진 컬럼 안에서 세 줄로 접히는 순간 읽히지 않는다.

          자동 클리어 줄은 **항상 마운트돼 있다**. 라이브 리전과 그 내용이 같은
          프레임에 붙으면 다수의 스크린리더가 변경으로 읽지 않는다(R1 M6). 비어
          있는 동안에는 줄 상자도 여백도 만들지 않으므로 레이아웃은 그대로다. */}
      <p
        id={clearedId}
        role="status"
        className="mt-2 text-meta text-warn empty:mt-0"
        data-testid={`${idPrefix}-cleared`}
      >
        {clearedNotice}
      </p>
      {/* `empty:mt-0`만 쓰고 `hidden`은 쓰지 않는다. display:none은 접근성
          트리에서 요소를 빼 버려서, 라이브 리전을 미리 마운트한 의미가 사라진다. */}
      {ignoredNotice && (
        <p
          id={ignoredId}
          className="mt-2 text-meta text-warn"
          data-testid={`${idPrefix}-ignored`}
        >
          {ignoredNotice}
        </p>
      )}
      {modelReason && (
        <p
          id={modelReasonId}
          className="mt-2 text-meta text-ink-muted"
          data-testid={`${idPrefix}-model-reason`}
        >
          {modelReason}
        </p>
      )}
      {effortReason && !sharedReason && (
        <p
          id={effortReasonId}
          className="mt-2 text-meta text-ink-muted"
          data-testid={`${idPrefix}-effort-reason`}
        >
          {effortReason}
        </p>
      )}
    </div>
  );
}
