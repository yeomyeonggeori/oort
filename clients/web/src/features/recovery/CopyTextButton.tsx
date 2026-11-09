import { useState } from "react";
import { Button } from "@/design/ui/button";
import { useClipboardCopy } from "@/design/hooks/useClipboardCopy";

// Reading this as: member-profile admin stage and login recovery help for internal team
// users on web+Tauri, density 5/10, motion 2/10.

// 복사 버튼 하나. 설정의 `CopyButton`은 「복사됨」을 `${label}됨`으로 짓는데 그 「됨」이 한국어
// 하나로 박혀 있어서 영어 문구에 못 쓴다. 그래서 라벨과 복사된 뒤의 말을 둘 다 사전에서 받는다.
// 클립보드와 「복사됨」이 풀리는 시계는 설정과 같은 한 벌(`useClipboardCopy`, ADR-0182 D5)을 쓴다:
// 이 파일이 두 번째 시계를 만들지 않는다. 복사에 실패하면(권한 거부) 아무 말도 하지 않고 값은 화면에
// 그대로 있다: 값 쪽이 `select-all`이라 사람이 직접 고를 수 있다. 값이 화면에 없는 자리(설정 > 업데이트의 연결 기록, #5587)는
// `failedLabel`을 건넨다: 그러면 실패를 같은 알림 자리에서 말하고 눈에도 보인다(다음 누름까지 남는다, 두 번째 시계 없음).
export function CopyTextButton({
  value,
  label,
  copiedLabel,
  failedLabel,
  testId,
  className,
}: {
  value: string;
  label: string;
  copiedLabel: string;
  failedLabel?: string;
  testId: string;
  className?: string;
}) {
  const { copied, copy } = useClipboardCopy(value);
  const [failed, setFailed] = useState(false);
  const showFailure = failed && !copied && failedLabel !== undefined;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={className}
        onClick={() => {
          setFailed(false);
          void copy().then((ok) => setFailed(!ok));
        }}
        data-testid={testId}
      >
        {copied ? copiedLabel : label}
      </Button>
      {/* 보이는 글자가 바뀌어도 읽는 도구는 그 자리에 머무른다: 결과는 한 번만 따로 알린다. */}
      {/* 실패는 눈에도 보인다(`data-failed`일 때만 sr-only를 푼다). 알림 자리는 하나로 그대로 둔다: 새로 끼운 알림 자리는 읽지 않는 도구가 있다. */}
      <span
        role="status"
        data-failed={showFailure || undefined}
        className="sr-only data-[failed]:not-sr-only data-[failed]:text-meta data-[failed]:text-danger"
      >
        {copied ? copiedLabel : showFailure ? failedLabel : ""}
      </span>
    </>
  );
}
