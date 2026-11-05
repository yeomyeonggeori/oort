import type { Message } from "@momo/core/lib/api";
import { editedMark } from "@momo/core/features/timeline/editedLabel";
import { Tooltip } from "@/design/ui/tooltip";
import { useLocaleService } from "@/i18n/useLocaleService";

// =============================================================================
// 꼬리의 「수정됨」과 고친 시각 (#5326, #5191 후속).
//
// 낱말은 사전(`timeline.edited.mark`)에서, 시각 문장(「오후 2:05에 수정됨」, 어제·다른 날은 앞에 날이 붙는다)은 코어의 한 함수
// (`editedMark`)에서 온다. 폰이 같은 함수를 쓰므로 두 화면이 같은 말을 한다.
//
// 가리키거나 키보드 초점이 가면 공용 `Tooltip`이 시각 문장을 띄운다(Slack·Discord의 「(edited)」와 같다). 키보드 초점이 닿아야 하므로
// 그냥 글자가 아니라 **행의 한 로빙 그룹의 구성원**(`data-row-action`)이다: 행은 여전히 탭 정거장 하나이고 ←/→로 이 낱말에 닿는다
// (`rowFocus.ts`, 탭 순서는 DOM이 정하므로 JSX에 `tabIndex`를 쓰지 않는다).
//
// `button`이 아니라 `role="note"`인 이유: 누르면 하는 일이 없는 읽기 전용 표지다. `button`으로 두면 화면 낭독이 「버튼」이라 읽고(눌러도
// 아무 일이 없다), 눌림 원장(ADR-0179 D5, `pressLedger.test.ts`)이 눌림 모양을 요구하는데 그것은 「눌러서 뭔가 된다」는 거짓 신호다.
// 이름 붙은 `note`는 값(시각 문장)을 읽어 주기만 한다. 접근성 이름은 낱말이 아니라 시각 문장 전체(「오후 2:05에 수정됨」)라서 화면 낭독이
// 시각까지 읽는다(보이는 글자 「수정됨」은 그 이름 안에 든다).
//
// 고친 시각을 모르는 줄(옛 캐시, 시각이 없는 프레임)은 지금까지와 같은 글자 하나다: 띄울 말이 없는 곳에 초점 정거장·툴팁을 만들지 않는다.
// =============================================================================

export function EditedMark({ message }: { message: Pick<Message, "state" | "editedAtMs"> }) {
  const locale = useLocaleService();
  // 「오늘」의 기준은 그리는 순간의 시계다. 행은 편집·실시간 프레임으로 다시 그려지고, 자정을 건너 열려 있는 동안 낡을 수 있지만 다음 그리기에서
  // 바로잡힌다(그 사이의 낡음은 「오늘」이 「어제」가 되는 정도이고 틀린 시각을 말하지는 않는다).
  const mark = editedMark(locale, message, Date.now());
  if (mark === null) return null;
  if (!mark.hasTime) return <span data-testid="edited-mark">{mark.mark}</span>;
  return (
    <Tooltip label={mark.full} side="top">
      <span
        role="note"
        data-row-action=""
        data-testid="edited-mark"
        aria-label={mark.full}
        className="-mx-1 rounded-md px-1 focus-visible:focus-ring"
      >
        {mark.mark}
      </span>
    </Tooltip>
  );
}
