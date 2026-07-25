import type { Message } from "@/lib/api";

// Synthetic, in-memory timeline for the 1k-scroll performance gate. This
// isolates react-virtuoso rendering cost from network/DB — the gate measures
// the WEBVIEW's virtualized-scroll behavior, which is independent of where the
// rows came from. Real seq-ordering and resume are measured separately against
// live momowebqa data (gates/gate-seq.mjs, gates/gate-resume.mjs).
export function makeSyntheticMessages(count: number): Message[] {
  const authors = [
    "00000000-0000-7000-8000-000000000101",
    "00000000-0000-7000-8000-000000000102",
  ];
  const base = Date.now() - count * 1000;
  const out: Message[] = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = {
      id: `synthetic-${i + 1}`,
      channelId: "synthetic",
      seq: i + 1,
      hlcTs: base + i * 1000,
      hlcCount: 0,
      authorMemberId: authors[i % authors.length],
      type: "text",
      body:
        `#${i + 1} 스트레스 메시지 · react-virtuoso 1k 스크롤 게이트. ` +
        (i % 5 === 0
          ? "조금 더 긴 줄로 가변 높이를 만들어 가상화가 실제 레이아웃 비용을 감당하는지 본다. ".repeat(
              2
            )
          : ""),
      state: "sent",
      createdAtMs: base + i * 1000,
    };
  }
  return out;
}
