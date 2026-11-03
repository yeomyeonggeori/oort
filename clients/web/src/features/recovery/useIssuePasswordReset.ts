import { useCallback, useEffect, useRef, useState } from "react";
import {
  issueMemberPasswordReset,
  type PasswordResetIssue,
  type RosterMember,
} from "@momo/core/lib/api";
import {
  passwordResetIssueFailure,
  passwordResetIssueRequired,
  type PasswordResetIssueFailure,
} from "@momo/core/features/directory/passwordResetIssue";
import { useSession } from "@/app/session";

// =============================================================================
// 「재설정 링크 만들기」의 단계 (ADR-0215 D6, #4603).
//
//   idle     멤버 프로필 그대로. 입구 단추만 있다.
//   confirm  확인 단계: 다섯 줄과 「내 비밀번호」 칸. 취소하면 idle로, 거절당하면 여기로 돌아온다.
//   issuing  요청이 나간 동안. 되돌릴 수 없는 일이 서버에서 벌어지는 중이라 취소·닫기를 막는다.
//   issued   링크가 한 번 보이는 단계.
//
// 링크는 **이 훅의 React state에만** 산다. props·store·query 캐시·localStorage·URL 어디에도 두지
// 않는다: 서버가 원문을 보관하지 않으므로 화면이 닫히면 다시 볼 길이 없는 것이 계약이고, 값을
// 살아남게 만드는 구현이 그 계약의 위반이다(`LinkOnce`와 같은 규칙). 이 훅은 멤버 프로필 패널과
// 함께 마운트되므로(멤버 id가 키) 닫거나 다른 멤버로 옮기면 상태째 사라진다.
// 입력한 비밀번호는 이 훅이 받아서 서버로 보낼 뿐 어디에도 남기지 않는다(칸의 state는 폼이 쥔다).
// =============================================================================

// 단계는 숫자 이름표다. 낱말 문자열(`"idle"`…)은 문구 장부(direct-copy)가 사람이 읽는 영어 글로 세어서,
// 화면 상태를 문자열로 들고 다니면 새 파일마다 「직접 문구」가 늘어난다. 이름표는 읽는 쪽도 이름으로 비교한다.
export const PasswordResetPhase = {
  Idle: 0,
  Confirm: 1,
  Issuing: 2,
  Issued: 3,
} as const;
export type PasswordResetPhase = (typeof PasswordResetPhase)[keyof typeof PasswordResetPhase];

export interface IssuePasswordResetHandle {
  phase: PasswordResetPhase;
  issued: PasswordResetIssue | null;
  failure: PasswordResetIssueFailure | null;
  /** 확인 단계를 취소할 때마다 하나 늘어난다: 입구 단추가 초점을 돌려받는 신호. */
  cancelTick: number;
  begin: () => void;
  /** confirm에서만 idle로 돌아간다. 요청 중·링크가 선 뒤에는 아무 일도 하지 않는다(Esc·바깥 누름이 부른다). */
  cancel: () => void;
  /** 거절이면 그 사유를, 성공이면 null을 돌려준다(폼이 비밀번호 칸을 비울지 정한다). */
  submit: (member: RosterMember, currentPassword: string) => Promise<PasswordResetIssueFailure | null>;
}

export function useIssuePasswordReset(): IssuePasswordResetHandle {
  const { workspaceId } = useSession();
  const [phase, setPhase] = useState<PasswordResetPhase>(PasswordResetPhase.Idle);
  const [issued, setIssued] = useState<PasswordResetIssue | null>(null);
  const [failure, setFailure] = useState<PasswordResetIssueFailure | null>(null);
  const [cancelTick, setCancelTick] = useState(0);
  // 요청이 나간 동안의 동기 자물쇠. `phase` state는 다음 렌더에야 서므로 같은 틱에 겹친 두 제출
  // (Enter 반복·더블클릭)은 state만으로는 못 막는다: 둘째 요청은 첫째 링크를 못 쓰게 만든다.
  const lock = useRef(false);
  const mounted = useRef(true);
  const phaseRef = useRef<PasswordResetPhase>(PasswordResetPhase.Idle);
  phaseRef.current = phase;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const begin = useCallback(() => {
    if (phaseRef.current !== PasswordResetPhase.Idle) return;
    setFailure(null);
    setPhase(PasswordResetPhase.Confirm);
  }, []);

  const cancel = useCallback(() => {
    if (phaseRef.current !== PasswordResetPhase.Confirm) return;
    setFailure(null);
    setPhase(PasswordResetPhase.Idle);
    setCancelTick((tick) => tick + 1);
  }, []);

  const submit = useCallback(
    async (member: RosterMember, currentPassword: string) => {
      if (lock.current) return null;
      // 빈 칸은 서버에 묻기 전에 그 칸에서 말한다(서버의 400 `current_password_required`와 같은 말).
      if (currentPassword === "") {
        const empty = passwordResetIssueRequired();
        setFailure(empty);
        return empty;
      }
      lock.current = true;
      setFailure(null);
      setPhase(PasswordResetPhase.Issuing);
      try {
        const issue = await issueMemberPasswordReset(workspaceId, member.id, currentPassword);
        // 닫힌 화면에는 링크를 두지 않는다: 늦게 온 응답은 버려진다(재발급하면 이 링크도 끝난다).
        if (!mounted.current) return null;
        setIssued(issue);
        setPhase(PasswordResetPhase.Issued);
        return null;
      } catch (cause) {
        const refused = passwordResetIssueFailure(cause);
        if (mounted.current) {
          setFailure(refused);
          setPhase(PasswordResetPhase.Confirm);
        }
        return refused;
      } finally {
        lock.current = false;
      }
    },
    [workspaceId]
  );

  return { phase, issued, failure, cancelTick, begin, cancel, submit };
}
