import { PackageCheck } from "lucide-react";
import { Button } from "@/design/ui/button";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import {
  ACTION_RESULT_SECRET_ONCE_NOTE,
  ACTION_RESULT_STATUS_NOTE,
  type AgentActionResultCard,
} from "@momo/core/features/timeline/actionResultCard";
import { formatCount } from "@momo/core/features/timeline/agentCardModel";
import { SETTINGS_SECTIONS } from "@/features/settings/settingsNav";
import { CardFrame, LabeledRow } from "./AgentCard";
import { ActionResultChip } from "./StatusChip";

// =============================================================================
// 워크스페이스 행동 결과 카드 (ADR-0186 D5 · 부록 B)
//
// 승인 카드 가족의 **끝난 쪽**이다. 같은 `CardFrame`, 같은 행, 같은 접힘을 쓰고
// 결정 컨트롤만 없다 — 이미 끝난 일에 승인·거부할 것이 없다. 그래서 y/n 키도
// footer 도 서지 않는다.
//
// ## 이 카드에 링크가 없는 것이 요점이다 (D4)
//
// 초대 링크 같은 1회 값은 결정 HTTP 응답에만 있었고, 승인한 사람의 화면에서
// 한 번 보이고 사라졌다(`ApprovalActions` 의 `LinkOnce`). 이 카드가 아는 것은
// **그 일이 있었다**는 사실과, 다시 필요하면 어디로 가면 되는지 하나다.
//
// 「재발급」을 이 카드가 직접 부르지 않는 것도 같은 규율이다: 버튼 하나로 새
// 자격을 만들면 그 값이 또 어딘가에 나타나야 하고, 그 자리는 결정 응답이 아니다.
// 그래서 `next` 는 **이동**이다 — 자격을 만드는 화면은 이미 있고, 그 화면이
// 자기 규율로 값을 한 번 보여 준다(`IssuedInviteCard`).
//
// ## 주소는 서버가 준 것을 그대로 쓰되, **도착할 수 있을 때만** 문이 된다
//
// `next.href` 는 이 제품 안의 경로다(부록 B 샘플: `/settings?section=invites`).
// 번역하지 않는다 — 클라이언트가 「초대는 아마 멤버 섹션일 테니」 하고 고쳐
// 보내면, 서버가 섹션 이름을 바꾼 날 사람이 조용히 엉뚱한 화면에 도착한다.
//
// 대신 **도착지를 모르면 문을 세우지 않는다**(design-review R1 H1). 앞 판은
// 「바깥 주소인가」만 물었고, 그래서 부록 B 원문인 `?section=invites` 가
// 그대로 문이 됐다 — 이 클라이언트에 `invites` 섹션은 없고(`settingsNav.ts`:
// `members` = 「멤버와 초대」), `SettingsRoute` 는 모르는 섹션을 **조용히
// 프로필로 접는다**. 누르면 아무 말 없이 엉뚱한 화면에 도착하는 문이었다.
//
// 판정은 팔레트와 같은 규칙이다(`serverActions.actionDestination` 은 모르는
// 행동 id 에 `null` 을 답한다). 한 클라이언트가 같은 질문 — 「이 목적지를 아는가」 —
// 에 두 가지로 답하면 그중 하나는 반드시 틀린 쪽이다.
//
// 문이 서지 않아도 카드는 말을 잃지 않는다: 상태 문장과 「1회 표시됐습니다 ·
// 다시 만드세요」가 그대로 남는다. 없는 방으로 가는 문을 그리지 않는다는 이
// 저장소의 규율(`LoginHandoffBody` 의 어포던스 부재 원칙)과 같은 자리다.
// =============================================================================

/** 내부 경로인가. `//host` 와 `https:` 는 이 카드가 열 수 있는 문이 아니다. */
// eslint-disable-next-line react-refresh/only-export-components -- 판정 하나짜리 순수 함수다. 시험이 이것을 직접 잰다(렌더 부재만 재면 왜 없는지는 못 잰다).
export function isInternalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

const SETTINGS_SECTION_IDS: ReadonlySet<string> = new Set(
  SETTINGS_SECTIONS.map((section) => section.id)
);

/**
 * 이 빌드가 **실제로 도착할 수 있는** 주소인가 (R1 H1).
 *
 * 설정 경로는 `?section=` 이 실재하는 섹션일 때만 참이다. 섹션 키가 아예 없는
 * `/settings` 는 기본 섹션(프로필)에 도착하므로 참이고, 그것은 조용한 폴백이
 * 아니라 그 주소가 뜻하는 화면 그대로다.
 *
 * 설정이 아닌 내부 경로는 지금 이 버전에서 **문이 되지 않는다**. 부록 B 가
 * 상정한 `next` 는 전부 설정 표면이고, 그 밖의 경로를 통과시키면 앱의 라우트
 * 표(`App.tsx`)를 이 카드가 두 번째로 갖게 된다 — 모르는 경로는 라우터의
 * `path="*"` 가 조용히 `/` 로 돌려보내므로, 그것도 같은 결함의 다른 얼굴이다.
 */
// eslint-disable-next-line react-refresh/only-export-components -- 위와 같은 이유: 시험이 이 판정을 직접 잰다.
export function isReachableHref(href: string): boolean {
  if (!isInternalHref(href)) return false;
  const [path, query = ""] = href.split("?", 2);
  if (path !== "/settings") return false;
  const section = new URLSearchParams(query).get("section");
  return section === null || SETTINGS_SECTION_IDS.has(section);
}

export function ActionResultBody({
  card,
  directory,
}: {
  card: AgentActionResultCard;
  directory: Directory;
}) {
  const decidedBy = card.decidedByMemberId
    ? memberFor(directory, card.decidedByMemberId)
    : null;
  const next =
    card.next !== null && isReachableHref(card.next.href) ? card.next : null;

  return (
    <CardFrame
      icon={<PackageCheck className="size-4" aria-hidden="true" />}
      title={card.title}
      chip={<ActionResultChip status={card.status} />}
      status={card.status}
      kind="action_result"
      detail={card.detail}
      // 문장과 문 하나는 <dl> 밖에 서야 유효한 HTML 이다. note 슬롯이 그 자리다.
      note={
        <div className="border-t border-line px-3 py-2">
          <p
            className="break-keep text-body text-ink"
            data-testid="action-result-note"
          >
            {ACTION_RESULT_STATUS_NOTE[card.status]}
          </p>
          {card.secretShownOnce && (
            <p
              className="mt-1 break-keep text-meta text-ink-muted"
              data-testid="action-result-secret-once"
            >
              {ACTION_RESULT_SECRET_ONCE_NOTE}
            </p>
          )}
          {next !== null && (
            // 이 클라이언트의 라우터는 해시다. `asChild` 로 앵커를 쓰는 이유는
            // 로그인 핸드오프 카드가 자기 버튼을 `outline` 으로 세운 것과 같다:
            // 수제 컨트롤의 경계는 `--line` 이라 WCAG 1.4.11 의 3:1 에 못 미친다.
            // `tap-target` 은 600px 미만에서만 44px 로 자란다 (R1 M6). 같은
            // 카드의 승인·거부가 이미 그 크기이고, 이 문만 28px 로 남을 이유가
            // 없다.
            <Button
              asChild
              variant="outline"
              size="sm"
              className="tap-target mt-2"
            >
              <a href={`#${next.href}`} data-testid="action-result-next">
                {next.label}
              </a>
            </Button>
          )}
        </div>
      }
    >
      {card.rows.map((row) => (
        <LabeledRow
          key={`result-${row.label}`}
          label={row.label}
          testId="action-result-row"
        >
          {row.value}
        </LabeledRow>
      ))}
      {card.omittedRows > 0 && (
        <LabeledRow label="그 밖에" testId="action-result-omitted">
          <span data-numeric>
            {formatCount(card.omittedRows)}개를 표시하지 못했습니다.
          </span>
        </LabeledRow>
      )}
      {decidedBy !== null && (
        <LabeledRow label="결정" testId="action-result-decided-by">
          {decidedBy.displayName}
        </LabeledRow>
      )}
    </CardFrame>
  );
}
