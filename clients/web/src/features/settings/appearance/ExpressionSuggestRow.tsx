import { useId } from "react";
import { Switch } from "@/design/ui/switch";
import { useExpressions } from "@/features/expressions/context";
import { useExpressionSuggestOn, writeExpressionSuggestOn } from "@/features/expressions/suggestSetting";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { SettingsRow } from "../shell/SettingsRow";

// Design Read: Reading this as: settings (설정 › 모양 › 대화 표시) for internal team users on web+Tauri, density 6/10, motion 1/10 (새 모양 없음: 다른 켜기·끄기 줄과 같은 `SettingsRow` + `Switch`).
//
// =============================================================================
// 설정 › 모양 › 대화 표시 › 「이모티콘 추천」 (#5493, owner 2026-11-07 「설정에서 다 끌 수도 있어요」).
//
// 글을 쓰다 멈추면 입력창 위에 뜨는 이모티콘 추천 줄(#5476)을 통째로 끄고 켜는 스위치 하나다. 기본은 켜짐이고, 이 기기 · 이 워크스페이스 · 이 사람에게만 저장된다(서버로 가지 않고 다른 멤버의 화면과
// 무관하다 - 이 카드의 설명 문장과 같은 약속이다). 줄의 ✕(그 대화의 낱말 하나만 앱을 다시 켤 때까지 끄기)와는 다른 선택이라 서로를 바꾸지 않는다.
//
// 스위치는 누르는 즉시 저장되고(저장 버튼 없음) 입력창이 바로 따라온다: 켜 둔 채로 친 글에 줄이 떠 있었다면 끄는 순간 걷히고, 다시 켜면 0.3초 뒤 선다.
// 이름과 설명은 사전 키(`expressions.suggest.settingLabel`·`settingHint`)이고 폰 설정이 같은 키를 쓴다. 보관함 저장소(`TeamExpressionsProvider`) 밖에서는 값을 가를 사람을 모르므로 행을 그리지 않는다
// (눌러도 안 바뀌는 컨트롤은 내보내지 않는다, ADR-0189 증보 1). 앱 안의 설정 화면은 늘 그 안에 있다.
// =============================================================================

export function ExpressionSuggestRow() {
  const { store } = useExpressions();
  const formatMessage = useFormatMessage();
  const labelId = useId();
  const descriptionId = useId();
  const workspaceId = store?.workspaceId ?? "";
  const memberId = store?.memberId ?? "";
  const on = useExpressionSuggestOn(workspaceId, memberId);
  if (store === null) return null;
  return (
    <SettingsRow
      label={formatMessage("expressions.suggest.settingLabel")}
      description={formatMessage("expressions.suggest.settingHint")}
      labelId={labelId}
      descriptionId={descriptionId}
      testId="expression-suggest-row"
      keep
    >
      <Switch
        checked={on}
        labelledBy={labelId}
        describedBy={descriptionId}
        onCheckedChange={(next) => writeExpressionSuggestOn(workspaceId, memberId, next)}
        testId="expression-suggest-toggle"
      />
    </SettingsRow>
  );
}
