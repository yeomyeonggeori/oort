import { defaultExpressionDiskBackend } from "./idb";
import { canVerifyImages } from "./bytes";
import { ensureSessionGeneration, readSessionGeneration } from "./generation";
import { expressionDiskName, type ExpressionDiskBackend, type ExpressionDiskCompartment } from "@momo/core/features/expressions/diskCache";

/** 저장소(`ExpressionStore`)가 쥐는 디스크 한 칸과 그 칸을 연 때의 세션 세대. */
export interface ExpressionDisk {
  readonly name: string;
  readonly compartment: ExpressionDiskCompartment;
  /** 이 칸을 연 뒤 세션이 끝나지 않았는가(로그아웃·만료·복원 거절이 세대를 올린다). 다른 탭이 올린 것도 본다. */
  sessionUnchanged(): boolean;
}

/**
 * 이 `(워크스페이스, 멤버)`의 디스크 칸을 연다. **하나라도 안 되면 `null`**이고 저장소는 지금처럼 메모리만 쓴다(ADR §14 M5, R1-L4):
 * id가 uuid가 아니다 · IndexedDB가 없다 · `localStorage`가 없다(세션 세대를 탭 사이에 나눌 수 없다) · sha256을 잴 수 없다(무결성을 확인할 수 없다).
 */
export function openExpressionDisk(workspaceId: string, memberId: string, backend: ExpressionDiskBackend = defaultExpressionDiskBackend()): ExpressionDisk | null {
  const name = expressionDiskName(workspaceId, memberId);
  if (name === null || !canVerifyImages()) return null;
  const generation = ensureSessionGeneration();
  if (generation === null) return null;
  const compartment = backend.open(name);
  if (compartment === null) return null;
  return { name, compartment, sessionUnchanged: () => readSessionGeneration() === generation };
}
