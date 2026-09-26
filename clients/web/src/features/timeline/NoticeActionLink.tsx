import { Link } from "react-router-dom";
import type { Message } from "@momo/core/lib/api";
import { noticeAction } from "@momo/core/features/timeline/noticeAction";
import { isReachableSettingsSection } from "@/features/settings/settingsNav";

/**
 * 서버 안내 줄 밑의 문 하나 (#2871). 호스티드 에이전트가 답하지 못한 사유를
 * 고칠 곳이 앱 안에 있으면 그리로 간다. 판정은 코어가 하고(`noticeAction`),
 * 도착할 수 없는 섹션이면 아무것도 그리지 않는다.
 */
export function NoticeActionLink({
  message,
}: {
  message: Pick<Message, "type" | "props">;
}) {
  const action = noticeAction(message, isReachableSettingsSection);
  if (action === null) return null;
  return (
    <div className="mt-1">
      <Link
        to={action.href}
        className="press rounded-sm text-meta text-signal-text underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:focus-ring"
        data-testid="notice-action"
      >
        {action.label}
      </Link>
    </div>
  );
}
