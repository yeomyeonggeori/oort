// 게이트 공용: 닫힘 전환이 끝난 뒤에 일어나는 포커스 복귀를 기다려 잰다.
//
// Esc나 닫기로 대화상자·라이트박스를 닫으면 포커스는 여는 요소로 돌아가야 한다. 그 복귀는 닫힘 전환(`detached`)이
// 끝난 같은 틱이 아니라 그 뒤 프레임에 일어난다. 닫힌 직후 한 번만 재면 경주다 — 같은 코드가 한 실행에서는 통과하고
// 다음 실행에서는 다른 줄에서 떨어졌다(#5048, gate:quote). 그래서 정해진 시간 안에 돌아오는지를 본다. 끝내
// 돌아오지 않으면(포커스가 body에 남으면) 여전히 false다 — 기다림이 실패를 삼키지 않는다.
//
// 요소가 다시 만들어질 수 있어 로케이터를 매번 다시 푼다.

/**
 * @param {import("playwright").Locator} locator 포커스가 돌아와야 하는 요소
 * @param {{ timeoutMs?: number; pollMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function focusReturnsTo(
  locator,
  { timeoutMs = 2_000, pollMs = 50 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const there = await locator
      .evaluate((node) => document.activeElement === node)
      .catch(() => false);
    if (there) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, pollMs));
  }
}
