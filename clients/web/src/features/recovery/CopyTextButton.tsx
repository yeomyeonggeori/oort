import { Button } from "@/design/ui/button";
import { useClipboardCopy } from "@/design/hooks/useClipboardCopy";

// Reading this as: member-profile admin stage and login recovery help for internal team
// users on web+Tauri, density 5/10, motion 2/10.

// 복사 버튼 하나. 설정의 `CopyButton`은 「복사됨」을 `${label}됨`으로 짓는데 그 「됨」이 한국어
// 하나로 박혀 있어서 영어 문구에 못 쓴다. 그래서 라벨과 복사된 뒤의 말을 둘 다 사전에서 받는다.
// 클립보드와 「복사됨」이 풀리는 시계는 설정과 같은 한 벌(`useClipboardCopy`, ADR-0182 D5)을 쓴다:
// 이 파일이 두 번째 시계를 만들지 않는다. 복사에 실패하면(권한 거부) 아무 말도 하지 않고 값은 화면에
// 그대로 있다: 값 쪽이 `select-all`이라 사람이 직접 고를 수 있다.
export function CopyTextButton({
  value,
  label,
  copiedLabel,
  testId,
  className,
}: {
  value: string;
  label: string;
  copiedLabel: string;
  testId: string;
  className?: string;
}) {
  const { copied, copy } = useClipboardCopy(value);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={className}
        onClick={() => void copy()}
        data-testid={testId}
      >
        {copied ? copiedLabel : label}
      </Button>
      {/* 보이는 글자가 바뀌어도 읽는 도구는 그 자리에 머무른다: 결과는 한 번만 따로 알린다. */}
      <span role="status" className="sr-only">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}
