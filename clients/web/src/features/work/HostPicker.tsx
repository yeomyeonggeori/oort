import { useState } from "react";
import { Loader2, Monitor } from "lucide-react";
import { Button } from "@/design/ui/button";
import { Select } from "@/design/ui/select";
import { uuidEq, type WorkHost } from "@/lib/api";

// =============================================================================
// 어느 호스트에서 다시 시작할지 고르는 폼 (ADR-0125 D11 / ADR-0143).
//
// 두 표면이 같은 act를 제안한다: 작업 세션 패널의 재개와 작업 흐름 상세의
// 이어받기. 둘의 문장은 이미 한 글자까지 같게 쓰기로 한 것이고(WorkPanel과
// WorkstreamDetailRoute의 "Git 계보만 새 호스트로 이어집니다" 두 줄), 그런데
// 컨트롤은 두 벌이었다. 그래서 어휘만 호출자가 주고 기하·상태·키보드는 여기
// 한 곳에 둔다 — FilterTabs가 인박스와 작업 흐름 사이에서 세운 형태 그대로,
// 두 번째 구현이 아니라 두 번째 호출자여야 한다.
//
// **커스텀 컨트롤이 아니다 (design-taste-web §1).** N중 택1은 플랫폼이 이미
// 가진 형태이고, 그 프리미티브가 `design/ui/select.tsx`(= OS의 `<select>`)다.
// 여기서 손으로 그릴 이유가 없다는 것이 이 파일의 §1 한 줄이다: 고를 것이
// 호스트 목록이므로 타입어헤드·키보드 순회·OS가 어떤 창 폭에서도 유지하는
// 히트 타깃이 전부 필요하고, listbox를 다시 만들면 그 셋을 JS로 다시 만들게
// 된다. 이 파일이 소유하는 것은 그 프리미티브를 감싼 **어휘와 진행 상태**뿐이다.
//
// v1(PR 918)은 자격 호스트마다 `variant="default"` 버튼 하나를 세웠다. 640px
// 한 줄에서는 읽혔지만 두 번째 호출자인 320px 작업 세션 pane에서 무너진다
// (2R H2 실측: 그룹 261px, 호스트마다 제 줄 96/127/170px, 전부 accent 채움):
//
//   - `min-w-action-sm`이 "짝을 같은 폭으로 세운다"는 목적으로 있는데(tokens
//     §4), 쌓이는 순간 폭이 가장 큰 변별자가 되고 **이름이 긴 호스트가 가장 큰
//     버튼**을 갖는다. 강조가 채움이 아니라 폭으로 넘어간다.
//   - §8은 "기본 액션 강조"를 요구하는데 N개의 동급 채움은 아무것도 강조하지
//     않는다. 다크에서 그 그룹이 창 전체에서 가장 밝은 영역이 됐다(목표 h1보다
//     위에).
//   - 자격 호스트 수에 상한이 없다. 열 대짜리 워크스페이스에서 이 형태는 열 줄
//     짜리 채움 벽이다.
//
// 그래서 **고르기와 실행을 분리한다**: 선택은 `<select>` 한 줄이 지고(선택지가
// 몇 개든 높이가 같다), 결정은 그 아래 채움 버튼 하나가 진다. 열린 상태에서
// 강조를 지는 것은 그룹이 아니라 그 한 버튼이고, 토글은 ghost로 물러난다.
//
// 두 가지는 v1에서 그대로 가져온다. 둘 다 실측된 이유가 있다.
//
// 1. 버튼 폭이 상태에 따라 변하지 않는다. `justify-end` 줄에서 라벨을
//    `재개` -> `재개하는 중`으로 바꾸면 누른 버튼의 폭이 바뀌고, 아직 포인터가
//    있는 자리에서 버튼이 움직인다(MOMO-676 M-3). 그래서 글자는 바꾸지 않고
//    **아이콘 자리**를 상설로 둔다 — 평소에는 기기 아이콘, 진행 중에는 같은
//    16px 상자의 스피너. 확정 버튼의 라벨이 호스트 이름을 담지 않는 것도 같은
//    이유다: 이름은 `<select>`가 말하고, 버튼은 폭이 고정된 동사만 말한다.
//    상태와 대상은 aria-busy와 접근성 이름이 나른다.
// 2. 그룹 라벨이 눈에 보인다. v1 이전의 `role="group" aria-label`은
//    스크린리더에만 있었고, 시각 사용자는 맨 기기명 두세 개만 봤다. 라벨은
//    실제 `<label>`이 되고, 그룹은 그것을 `aria-labelledby`로 되짚는다.
//
// **진행 중인 버튼은 disabled가 아니다** (tokens.md §5b, plugins/model.ts
// `pluginActionButtonState`). v1은 `disabled={busyHostId !== null}`로 진행 중인
// 자기 자신까지 껐고, `disabled:opacity-50`이 진행 중 라벨을 라이트 2.20:1 /
// 다크 3.23:1로 떨어뜨렸다 — 그것이 유일한 진행 신호일 때. 게다가 Chromium은
// 포커스된 요소가 disabled가 되는 순간 blur하므로, 키보드 사용자는 Enter를 누른
// 직후 문서 최상단으로 떨어졌다. 진행 중인 쓰기는 관측 가능한 것이지 불가용한
// 것이 아니다. 그래서 확정 버튼은 진행 중에도 enabled + 풀 컨트라스트로 두고,
// 실제로 불가용한 것 — 요청이 나가 있는 동안의 **대상 선택** — 만 disabled다.
// 중복 클릭은 호출자가 막는다(WorkPanel.resumeOnHost, WorkstreamDetailRoute의
// pendingHostId 가드).
// =============================================================================

export interface HostPickerCopy {
  /** 눈에 보이는 그룹/선택 라벨. "이어받을 호스트" · "재개할 호스트". */
  group: string;
  /** 확정 버튼의 눈에 보이는 라벨. 폭이 흔들리지 않게 호스트 이름을 담지 않는다. */
  confirm: string;
  /** 확정 버튼의 접근성 이름. "성재 맥북에서 이어받기". */
  action: (hostName: string) => string;
  /** 진행 중인 버튼의 접근성 이름. "성재 맥북에서 이어받는 중". */
  busy: (hostName: string) => string;
}

export function HostPicker({
  id,
  labelId,
  copy,
  targets,
  busyHostId,
  onPick,
  groupTestId,
  selectTestId,
  confirmTestId,
}: {
  /** 토글이 `aria-controls`로 가리키는 이 그룹의 id. */
  id: string;
  labelId: string;
  copy: HostPickerCopy;
  /** 비어 있으면 이 폼은 그려지지 않는다 — 호출자가 그 자리에 문장을 놓는다. */
  targets: readonly WorkHost[];
  /** 이 호스트로 요청이 나가 있다. null이면 아무것도 진행 중이 아니다. */
  busyHostId: string | null;
  onPick: (hostId: string) => void;
  groupTestId?: string;
  selectTestId: string;
  confirmTestId: string;
}) {
  const [pickedId, setPickedId] = useState<string | null>(null);

  // 고아 세션의 자격 호스트는 살아 있는 투영이라 이 폼이 열려 있는 동안에도
  // 줄어들 수 있다. 고른 것이 사라지면 첫 번째로 되돌아간다 — effect로
  // 되돌리면 사라진 호스트를 가리키는 프레임이 한 번 그려지고, 그 프레임에서
  // 누르면 없는 호스트로 요청이 나간다.
  const busyHost =
    busyHostId === null
      ? undefined
      : targets.find((host) => uuidEq(busyHostId, host.id));
  const chosen =
    busyHost ??
    targets.find((host) => uuidEq(pickedId ?? undefined, host.id)) ??
    targets[0];
  if (chosen === undefined) return null;
  const busy = busyHostId !== null;
  const selectId = `${id}-select`;

  return (
    <div
      id={id}
      className="mt-2 flex flex-col gap-2"
      role="group"
      aria-labelledby={labelId}
      data-testid={groupTestId}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label
          id={labelId}
          htmlFor={selectId}
          className="break-keep text-meta text-ink-muted"
        >
          {copy.group}
        </label>
        {/* 요청이 나가 있는 동안 대상은 진짜로 바꿀 수 없다. 이쪽은 disabled가
            맞고(tokens §5b의 "genuinely cannot act"), 흐려져도 진행 신호를
            잃지 않는다 — 진행은 아래 버튼의 스피너와 접근성 이름이 나른다. */}
        <Select
          id={selectId}
          value={chosen.id}
          disabled={busy}
          onChange={(event) => setPickedId(event.target.value)}
          data-testid={selectTestId}
          data-host-id={chosen.id}
        >
          {targets.map((host) => (
            <option key={host.id} value={host.id}>
              {host.displayName}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="default"
          size="sm"
          aria-busy={busy || undefined}
          aria-label={
            busy ? copy.busy(chosen.displayName) : copy.action(chosen.displayName)
          }
          className="min-w-action-sm max-w-full"
          data-testid={confirmTestId}
          data-host-id={chosen.id}
          data-busy={busy ? "" : undefined}
          onClick={() => onPick(chosen.id)}
        >
          {busy ? (
            <Loader2 aria-hidden="true" className="spinner-busy" />
          ) : (
            // 상설 자리다. 비워두면 스피너가 붙는 순간 버튼이 24px 넓어져
            // 포인터 아래에서 자기 자신이 움직인다(위 1번).
            <Monitor aria-hidden="true" />
          )}
          <span className="min-w-0 truncate">{copy.confirm}</span>
        </Button>
      </div>
    </div>
  );
}
