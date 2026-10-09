import { useEffect } from "react";
import { agentPortRetireLegacy, isDesktop } from "@/lib/tauri";

/**
 * 한 번 하는 정리(#3567, ADR-0198 증보 1 D2 4). 예전 앱이 `claude mcp add-json …oort`로 등록해
 * 둔 맥이면 `mcp remove`를 한 번 부르고, 그 뒤로는 셸이 표식 파일을 보고 아무것도 하지 않는다.
 * 표식 있는 기기(앱이 `add-json`을 성공시킨 항목)가 없으면 CLI 명령도 없다. 화면에 아무것도
 * 그리지 않고, 실패는 조용히 다음 실행에 다시 한다(셸이 시도 횟수를 센다).
 */
export function LegacyAgentPortCleanup() {
  useEffect(() => {
    if (!isDesktop()) return;
    void agentPortRetireLegacy();
  }, []);
  return null;
}
