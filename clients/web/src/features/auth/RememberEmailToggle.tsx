import { Switch } from "@/design/ui/switch";
import { useMessages } from "@/i18n/useMessages";

// Reading this as: onboarding for internal team users on web+Tauri,
// density 5/10, motion 2/10.

// 로그인 화면(D1)의 「이메일 기억하기」 한 줄 (#4669). 켜면 로그인에 성공한 뒤 이 서버의
// 이메일을 기억하고, 끄면 저장된 이메일을 **그 자리에서** 지운다(규칙은 코어
// `rememberedLogin`). 이름은 라벨이 걸고, 이 기기에만 저장한다는 말은 읽는 도구에만 보탠다:
// 입력 폼 한가운데에서 눈으로 읽을 두 번째 문장을 늘리지 않는다.
export function RememberEmailToggle({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  const messages = useMessages();
  return (
    <div className="flex items-center gap-3" data-testid="login-remember-row">
      <Switch
        id="connect-remember"
        checked={checked}
        onCheckedChange={onCheckedChange}
        describedBy="connect-remember-hint"
        testId="login-remember"
      />
      <label htmlFor="connect-remember" className="tap-target flex flex-1 items-center text-body text-ink">
        {messages.formatMessage("connect.rememberEmail.label")}
      </label>
      <span id="connect-remember-hint" className="sr-only">
        {messages.formatMessage("connect.rememberEmail.hint")}
      </span>
    </div>
  );
}
