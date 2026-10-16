import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Input } from "@/design/ui/input";

// 키·토큰을 붙여 넣는 칸 (#3885). 평소엔 가려진 password 칸이고, 오른쪽 눈 버튼으로
// 지금 치고 있는(붙여 넣은) 값만 확인한다.
//
// - 칸은 **같은 `<input>` 하나**다. 눈은 `type`만 바꾼다: 값·캐럿·선택·비제어 DOM 값이
//   그대로다(TeamKeyForm은 키를 React 상태에 싣지 않고 칸의 DOM 값으로만 든다).
//   text + 가림 글꼴로 흉내 내지 않는다: 값이 접근성 트리에 평문으로 나간다(#2961).
// - 눈 상태는 이 칸 안에만 있다. 저장(폼 submit)·초기화·언마운트에서 가림으로
//   돌아간다. 저장된 키는 서버가 다시 내려주지 않으므로 눈은 방금 친 값에만 해당한다.
// - 버튼을 눌러도 칸이 초점을 잃지 않게 mousedown을 막는다(캐럿 유지). 키보드는 Tab으로
//   버튼에 가서 Enter/Space로 누르고, 그때도 캐럿 위치는 되돌려 놓는다.

export type SecretInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
> & {
  /** 눈 버튼의 시험 id. */
  revealTestId?: string;
};

export const SecretInput = React.forwardRef<HTMLInputElement, SecretInputProps>(
  ({ className, disabled, revealTestId, ...props }, forwardedRef) => {
    const [shown, setShown] = React.useState(false);
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const caretRef = React.useRef<{ start: number; end: number } | null>(null);

    const setRef = React.useCallback(
      (node: HTMLInputElement | null) => {
        inputRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    // type이 바뀐 직후 캐럿·선택을 되돌린다(Chromium·WebKit은 type을 바꾸면 선택을 잃는다).
    // 한 번은 커밋 직후, 한 번은 다음 프레임에(엔진이 레이아웃 뒤에 선택을 지우는 경우).
    React.useLayoutEffect(() => {
      const caret = caretRef.current;
      if (!caret) return;
      const restore = () => {
        const el = inputRef.current;
        if (!el) return;
        try {
          el.setSelectionRange(caret.start, caret.end);
        } catch {
          // 선택을 못 쓰는 입력 종류면 값만 유지된다.
        }
      };
      restore();
      const frame = requestAnimationFrame(() => {
        restore();
        caretRef.current = null;
      });
      return () => cancelAnimationFrame(frame);
    }, [shown]);

    // 저장(submit)·초기화(reset)에서 가림으로 돌아간다. 취소·닫기는 언마운트가 한다.
    React.useEffect(() => {
      const form = inputRef.current?.form;
      if (!form) return;
      const hide = () => setShown(false);
      form.addEventListener("submit", hide);
      form.addEventListener("reset", hide);
      return () => {
        form.removeEventListener("submit", hide);
        form.removeEventListener("reset", hide);
      };
    }, []);

    function toggle() {
      const el = inputRef.current;
      if (el)
        caretRef.current = {
          start: el.selectionStart ?? el.value.length,
          end: el.selectionEnd ?? el.value.length,
        };
      setShown((value) => !value);
    }

    const label = shown ? "키 가리기" : "키 보기";
    const Icon = shown ? EyeOff : Eye;
    return (
      <div className="relative flex min-w-0 items-center">
        <Input
          {...props}
          ref={setRef}
          type={shown ? "text" : "password"}
          disabled={disabled}
          className={cn("pr-8", className)}
        />
        {/* press가 position을 쓰므로 자리 잡기는 바깥 칸이 한다. */}
        <span className="absolute inset-y-0 right-0 flex w-8">
          <button
            type="button"
            aria-label={label}
            aria-pressed={shown}
            title={label}
            disabled={disabled}
            // 눌러도 칸의 초점·캐럿을 뺏지 않는다.
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggle}
            className="press inline-flex size-full items-center justify-center rounded-lg text-ink-muted hover:text-ink focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
            data-testid={revealTestId}
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        </span>
      </div>
    );
  },
);
SecretInput.displayName = "SecretInput";
