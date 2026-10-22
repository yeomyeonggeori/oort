import type { ReactNode } from "react";

/**
 * 「」로 묶은 단추 이름과 뒤따르는 조사를 한 덩어리로 묶는다(#4220, design-review M2).
 *
 * `word-break: keep-all` 은 한글 음절 사이만 붙든다. 「Create GitHub App」을 처럼 닫는 괄호와 조사
 * 사이는 줄을 바꿀 수 있는 자리라서, 좁은 폭에서 조사 하나가 줄머리에 선다(`latin_particle` 검사는
 * 줄바꿈을 보지 않는다: 사람만 잡는 축). 덩어리가 한 줄을 넘지 않는 짧은 구에만 쓴다.
 */
export function NoBreak({ children }: { children: ReactNode }) {
  return <span className="whitespace-nowrap">{children}</span>;
}
