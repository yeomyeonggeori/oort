import type { ComponentProps } from "react";
import { HarnessLoginDialog } from "./HarnessLoginDialog";
import { useRegisterContext } from "./useRegisterContext";

/**
 * 로그인 모달에 「에이전트로 만들기」 맥락을 붙인다(#3389). 맥락은 서버 값(워크스페이스
 * 설정)을 읽는 훅이라, 모달이 열려 있을 때만 읽는다: 닫힌 화면이 요청을 더하지 않는다.
 */
export function RegisterAwareLoginDialog(props: ComponentProps<typeof HarnessLoginDialog>) {
  return props.harness === null ? (
    <HarnessLoginDialog {...props} />
  ) : (
    <WithRegister {...props} />
  );
}

function WithRegister(props: ComponentProps<typeof HarnessLoginDialog>) {
  const register = useRegisterContext();
  return <HarnessLoginDialog {...props} register={props.register ?? register} />;
}
