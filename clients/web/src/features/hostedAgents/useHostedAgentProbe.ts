import { useEffect, useState } from "react";
import {
  detectHostedAgents,
  isDesktop,
  type HostedAgentProbe,
} from "@/lib/tauri";

/**
 * 데스크탑에서만 프로브한다. 브라우저 탭은 즉시 빈 목록이라 초대 UI 가
 * 한 프레임도 서지 않는다 (E5 미설치·순수 웹 침묵).
 *
 * `ready` 가 거짓인 동안에도 그리지 않는다. 로컬 관찰은 짧고, 스켈레톤을
 * 미설치 머신에 세우는 편이 침묵보다 시끄럽다.
 */
export function useHostedAgentProbe(): {
  desktop: boolean;
  ready: boolean;
  probes: HostedAgentProbe[];
} {
  const desktop = isDesktop();
  const [probes, setProbes] = useState<HostedAgentProbe[] | null>(
    desktop ? null : []
  );

  useEffect(() => {
    if (!desktop) {
      setProbes([]);
      return;
    }
    let cancelled = false;
    void detectHostedAgents().then((result) => {
      if (!cancelled) setProbes(result);
    });
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  return {
    desktop,
    ready: probes !== null,
    probes: probes ?? [],
  };
}
