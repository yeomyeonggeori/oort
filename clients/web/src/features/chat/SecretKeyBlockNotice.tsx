import { CircleAlert } from "lucide-react";
import { SECRET_KEY_BLOCK_COPY } from "@momo/core/features/chat/secretKey";

/**
 * 키를 붙여 넣어 전송을 막았을 때 입력창 위에 서는 한 줄 (#2942 GC-1).
 *
 * 시안 `chat-genui-connect/mockups.html` ① 「키 붙여넣기 차단」의 `.inlinewarn`.
 * 토스트가 아니라 이 자리에서 말한다(ADR-0182). 채널·스레드 컴포저가 같은 한
 * 줄을 쓴다 — 키는 어느 입력창에서든 같은 사고다. 입력창은 이 줄을 설명으로
 * 읽는다(`aria-describedby`).
 */
export function SecretKeyBlockNotice({
  id,
  testId,
  cardAvailable,
}: {
  id: string;
  testId: string;
  /** `/연결 팀키`가 지금 카드를 여는가, 설정으로 가는가(design-review M-2). */
  cardAvailable: boolean;
}) {
  return (
    <p
      id={id}
      role="alert"
      className="mb-2 flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-meta font-medium text-warn"
      data-testid={testId}
    >
      <CircleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
      <span>
        {SECRET_KEY_BLOCK_COPY.lead}{" "}
        <b className="font-semibold">{SECRET_KEY_BLOCK_COPY.command}</b>
        {cardAvailable ? SECRET_KEY_BLOCK_COPY.tail : SECRET_KEY_BLOCK_COPY.tailFallback}
      </span>
    </p>
  );
}
