import { Loader2, Monitor } from "lucide-react";
import { Button } from "@/design/ui/button";
import { uuidEq, type WorkHost } from "@/lib/api";

// =============================================================================
// 어느 호스트에서 다시 시작할지 고르는 줄 (ADR-0125 D11 / ADR-0143).
//
// 두 표면이 같은 act를 제안한다: 작업 세션 패널의 재개와 작업 흐름 상세의
// 이어받기. 둘의 문장은 이미 한 글자까지 같게 쓰기로 한 것이고(WorkPanel과
// WorkstreamDetailRoute의 "Git 계보만 새 호스트로 이어집니다" 두 줄), 그런데
// 컨트롤은 두 벌이었다. 그래서 어휘만 호출자가 주고 기하·상태·키보드는 여기
// 한 곳에 둔다 — FilterTabs가 인박스와 작업 흐름 사이에서 세운 형태 그대로,
// 두 번째 구현이 아니라 두 번째 호출자여야 한다.
//
// 세 가지가 v1과 다르고, 셋 다 실측된 이유가 있다.
//
// 1. 위계 (design-taste-web §8). 호스트 버튼은 이 블록의 결정이므로 채움
//    (variant="default")이고, 그것을 여는 토글은 열린 뒤 ghost로 물러난다.
//    v1은 `호스트 선택 닫기`와 `성재 맥북`이 같은 outline·같은 size로 쌓여,
//    화면에서 가장 되돌리기 어려운 버튼과 그것을 접는 버튼이 같은 무게였다
//    (PR 918 R1 M3).
//
// 2. 라벨이 눈에 보인다. v1의 `role="group" aria-label`은 스크린리더에만
//    있었고, 시각 사용자는 맨 기기명 두세 개만 봤다. 라벨은 실제 텍스트가
//    되고 그룹은 그것을 `aria-labelledby`로 되짚는다.
//
// 3. 버튼 폭이 상태에 따라 변하지 않는다. `flex-wrap justify-end` 줄에서
//    라벨을 `성재 맥북` -> `이어받는 중`으로 바꾸면 누른 버튼의 폭이 바뀌고,
//    같은 줄의 형제 버튼이 아직 포인터가 있는 자리에서 움직인다. 이것이
//    --spacing-action-sm이 이름을 얻은 그 경우인데(MOMO-676 M-3), 여기서는
//    최소 폭만으로는 부족하다: size="sm" 실측에서 `성재 맥북`은 ~84px,
//    스피너를 단 `이어받는 중`은 ~120px라 96px 바닥을 위로 넘어선다. 그래서
//    글자는 바꾸지 않고 **아이콘 자리**를 상설로 둔다 — 평소에는 기기 아이콘,
//    진행 중에는 같은 16px 상자의 스피너. 폭은 두 상태에서 같고, 기기 이름은
//    사라지지 않으며, 상태는 aria-busy와 접근성 이름이 나른다.
//    min-w-action-sm은 그 위에서 짧은 이름들을 같은 폭으로 세우는 몫만 한다.
// =============================================================================

export interface HostPickerCopy {
  /** 눈에 보이는 그룹 라벨. "이어받을 호스트" · "재개할 호스트". */
  group: string;
  /** 버튼의 접근성 이름. "성재 맥북에서 이어받기". */
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
  hostTestId,
}: {
  /** 토글이 `aria-controls`로 가리키는 이 그룹의 id. */
  id: string;
  labelId: string;
  copy: HostPickerCopy;
  targets: readonly WorkHost[];
  /** 이 호스트로 요청이 나가 있다. null이면 아무것도 진행 중이 아니다. */
  busyHostId: string | null;
  onPick: (hostId: string) => void;
  groupTestId?: string;
  hostTestId: string;
}) {
  return (
    <div
      id={id}
      className="mt-2 flex flex-wrap items-center justify-end gap-2"
      role="group"
      aria-labelledby={labelId}
      data-testid={groupTestId}
    >
      {/* 라벨은 왼쪽 끝에 남고 선택지는 오른쪽에 모인다. 좁은 판에서 줄이
          넘어가면 라벨이 첫 줄에 그대로 있으므로, 무엇을 고르는 중인지가
          버튼들과 떨어져도 화면에서 사라지지 않는다. */}
      <p
        id={labelId}
        className="mr-auto min-w-0 break-keep text-meta text-ink-muted"
      >
        {copy.group}
      </p>
      {targets.map((host) => {
        const busy = uuidEq(busyHostId ?? undefined, host.id);
        return (
          <Button
            key={host.id}
            type="button"
            variant="default"
            size="sm"
            disabled={busyHostId !== null}
            aria-busy={busy || undefined}
            aria-label={busy ? copy.busy(host.displayName) : copy.action(host.displayName)}
            className="min-w-action-sm max-w-full"
            data-testid={hostTestId}
            data-host-id={host.id}
            data-busy={busy ? "" : undefined}
            onClick={() => onPick(host.id)}
          >
            {busy ? (
              <Loader2 aria-hidden="true" className="spinner-busy" />
            ) : (
              // 상설 자리다. 비워두면 스피너가 붙는 순간 버튼이 24px 넓어져
              // 형제 버튼을 포인터 아래에서 밀어낸다(위 3번). 아이콘 하나가
              // 그 자리를 차지하면서 이 줄이 무엇을 고르는 줄인지도 말한다.
              <Monitor aria-hidden="true" />
            )}
            <span className="min-w-0 truncate">{host.displayName}</span>
          </Button>
        );
      })}
    </div>
  );
}
