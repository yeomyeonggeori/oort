/**
 * 행의 시각 글자(`HH:mm`, 이 기기의 시간대). 확정된 행(`MessageRow`)과 보내는 중인 메아리(`PendingRow`, #4468)가 **같은 함수**를
 * 쓴다: 교체 때 시각 글자가 한 글자라도 다르면 그것이 깜빡임이다. 컴포넌트 파일 밖에 둔 것은 한 파일이 컴포넌트와 함수를 함께
 * 내보내면 fast refresh 가 그 파일을 통째로 다시 불러오기 때문이다(`react-refresh/only-export-components`).
 */
export function timeLabel(atMs: number): string {
  const d = new Date(atMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
