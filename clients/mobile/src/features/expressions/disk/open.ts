import {expressionDiskName} from '@momo/core/features/expressions/diskCache';
import {defaultPhoneDiskBackend} from './fileBackend';
import {readSessionGeneration} from './generation';
import type {PhoneDiskBackend, PhoneExpressionDisk} from './port';

/**
 * 이 `(워크스페이스, 멤버)`의 보관 칸을 연다. **안 되면 `null`**이고 저장소는 예전처럼 세션 폴더의 임시 파일만 쓴다(ADR §14 M5, R1-L4의 닫힌 쪽):
 * id 가 uuid 모양이 아니다(칸 이름을 만들지 못한다) · 칸을 열 수 없다.
 */
export function openPhoneExpressionDisk(
  workspaceId: string,
  memberId: string,
  backend: PhoneDiskBackend = defaultPhoneDiskBackend(),
): PhoneExpressionDisk | null {
  const name = expressionDiskName(workspaceId, memberId);
  if (name === null) return null;
  const compartment = backend.open(name);
  if (compartment === null) return null;
  let generation = readSessionGeneration();
  return {
    name,
    compartment,
    sessionUnchanged: () => readSessionGeneration() === generation,
    arm: () => {
      generation = readSessionGeneration();
    },
  };
}
