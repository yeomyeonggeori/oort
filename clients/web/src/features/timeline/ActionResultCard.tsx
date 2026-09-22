import { PackageCheck } from "lucide-react";
import { Button } from "@/design/ui/button";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import {
  ACTION_RESULT_SECRET_ONCE_NOTE,
  ACTION_RESULT_STATUS_NOTE,
  type AgentActionResultCard,
} from "@momo/core/features/timeline/actionResultCard";
import { formatCount } from "@momo/core/features/timeline/agentCardModel";
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
// ## 주소는 서버가 준 것을 그대로 쓰되, 밖으로는 나가지 않는다
//
// `next.href` 는 이 제품 안의 경로다(부록 B 샘플: `/settings?section=invites`).
// 번역하지 않는다 — 클라이언트가 「초대는 아마 멤버 섹션일 테니」 하고 고쳐
// 보내면, 서버가 섹션 이름을 바꾼 날 사람이 조용히 엉뚱한 화면에 도착한다.
// 대신 **바깥 주소면 그리지 않는다**: 카드는 서버가 붙인 props 로만 서고
// (D5), 그 props 가 워크스페이스 밖으로 나가는 문이 되어서는 안 된다.
// =============================================================================

/** 내부 경로인가. `//host` 와 `https:` 는 이 카드가 열 수 있는 문이 아니다. */
// eslint-disable-next-line react-refresh/only-export-components -- 판정 하나짜리 순수 함수다. 시험이 이것을 직접 잰다(렌더 부재만 재면 왜 없는지는 못 잰다).
export function isInternalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
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
  const next = card.next !== null && isInternalHref(card.next.href) ? card.next : null;

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
            <Button asChild variant="outline" size="sm" className="mt-2">
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
