import { Check } from "lucide-react";
import { OortLoader } from "@/design/brand/OortLoader";
import { CONNECTION_MARK, type ConnectionMark as Mark } from "@momo/core/features/connection/presentation";

/**
 * 연결 카드·띠 곁의 표시 하나. 다시 붙는 동안은 오르트 로더가 돌고, 진행 중인 것이 없으면(기기 오프라인) 같은
 * 마크가 서 있고, 방금 돌아왔으면 확인 표시다(`connectionPresentation.ts`가 어느 것인지 정한다). 장식이라
 * 이름은 곁의 문장이 진다.
 */
export function ConnectionMark({ mark, inline = false }: { mark: Mark; inline?: boolean }) {
  return (
    <span aria-hidden="true" data-connection-mark={mark} className="inline-flex shrink-0 items-center">
      {mark === CONNECTION_MARK.check ? (
        <Check className="size-4 text-ok" />
      ) : (
        <OortLoader inline={inline} still={mark === CONNECTION_MARK.still} />
      )}
    </span>
  );
}
