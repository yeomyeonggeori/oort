import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { Loader2 } from "lucide-react";
import type { RosterMember } from "@momo/core/lib/api";
import { AVATAR_ENTRY_COPY } from "@momo/core/features/workspace/avatarEditorCopy";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
// 편집기는 지연 청크다. 값(value)은 아래 `import()` 로만 가져오고, 이 파일은 그 디렉터리에서 **타입만** 가져온다
// (`profileAvatarEditorLazy.test.ts` 가 소스를 읽어 지킨다: 정적 import 가 하나 생기면 편집기 전체가 메인으로 들어온다).
import type { AvatarEditorDialogProps } from "./avatarEditor/AvatarEditorDialog";

// 내 아바타: 한 단추가 편집기를 연다 (#4261, 앞 판 #3277 은 사진 고르기·지우기 단추 둘이었다).
//
// 사진 · 이모지 + 배경색 · 코메토를 한 대화상자(`AvatarEditorDialog`)에서 고르고 저장한다. 사진 올리기와 지우기의 논리
// (업로드 세션, 로스터 갱신, 새 주소 캐시 채우기)는 그대로 편집기가 지고, 이 필드는 **열기**와 **끝난 뒤의 한 줄**만
// 맡는다. 성공하면 로스터를 다시 받는다 - 그 한 번의 쓰기로 사이드바·멤버 목록·메시지의 내 아바타가 함께 바뀐다.
//
// 진행은 잠금이 아니다(#1486 문법): 열고 있는 동안 단추는 `aria-busy` 로 말하고 native `disabled` 로 초점을 떨구지
// 않는다. 버튼 폭은 모든 상태에서 같다(`min-w-avatar-action`, 이름 붙은 폭 - 닫힌 spacing 스케일은 `min-w-28` 을 만들지
// 않는다) - 프로필 줄이 흔들리면 안 된다(#3276).
//
// 히어로의 카메라 손잡이는 이 단추를 대신 누른다(#3603): 손잡이가 편집기를 직접 열면 오프라인·잠금을 건너뛰므로 잠금을
// 지는 진짜 단추 하나로 길을 모은다. 대화상자가 닫히면 초점은 이 단추로 돌아온다(`opener`).

type EditorComponent = (props: AvatarEditorDialogProps) => React.JSX.Element;

let editorLoad: Promise<EditorComponent> | null = null;

/** 편집기 청크를 받는다. 실패하면 다음에 다시 시도하도록 기억을 지운다(끊긴 청크의 실패는 모듈 맵에 남지 않게 새 약속을 만든다). */
function loadEditor(): Promise<EditorComponent> {
  editorLoad ??= import("./avatarEditor/AvatarEditorDialog").then(
    (module) => module.AvatarEditorDialog,
    (failure: unknown) => {
      editorLoad = null;
      throw failure;
    }
  );
  return editorLoad;
}

export function ProfileAvatarField({
  workspaceId,
  me,
  offline,
  changeRef: externalChangeRef,
  onBusyChange,
}: {
  workspaceId: string;
  me: RosterMember | null;
  offline: boolean;
  /**
   * 히어로의 카메라 손잡이가 「아바타 바꾸기」 단추를 대신 누를 수 있게 밖에서 쥔 ref (#3603).
   * 손잡이가 편집기를 직접 열면 잠금을 건너뛰므로, 잠금을 지는 진짜 단추 하나로 길을 모은다.
   */
  changeRef?: RefObject<HTMLButtonElement>;
  /** 편집기가 올리는 중·되돌리는 중을 히어로가 알아 카메라 손잡이를 같이 잠글 수 있게 한다. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const ownChangeRef = useRef<HTMLButtonElement>(null);
  const changeRef = externalChangeRef ?? ownChangeRef;
  const hintId = useId();
  const [Editor, setEditor] = useState<EditorComponent | null>(null);
  const [open, setOpen] = useState(false);
  // 열 때마다 올라가는 번호: 편집기는 열 때마다 새로 서서(빈 초안) 지난번 고른 것이 남지 않는다.
  const [session, setSession] = useState(0);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // 단추 위에 포인터가 오거나 초점이 오면 청크를 미리 받아 둔다(눌렀을 때 기다리지 않게). 실패는 누를 때 다시 말한다.
  const prefetch = useCallback(() => {
    void loadEditor().catch(() => undefined);
  }, []);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function openEditor() {
    if (offline || loading) return;
    setDone(null);
    setLoadFailed(false);
    setLoading(true);
    loadEditor().then(
      (component) => {
        if (!mounted.current) return;
        setLoading(false);
        setEditor(() => component);
        setSession((n) => n + 1);
        setOpen(true);
      },
      () => {
        if (!mounted.current) return;
        setLoading(false);
        setLoadFailed(true);
      }
    );
  }

  const describedBy = [hintId, offline ? "profile-offline-reason" : null].filter(Boolean).join(" ");

  return (
    <div className="flex flex-col gap-2" data-testid="profile-avatar-field">
      <div className="flex flex-wrap items-center justify-center gap-2 @sm:justify-start">
        <Button
          ref={changeRef}
          type="button"
          variant="outline"
          size="sm"
          aria-label={loading ? undefined : AVATAR_ENTRY_COPY.open}
          aria-haspopup="dialog"
          aria-describedby={describedBy}
          aria-disabled={offline || undefined}
          aria-busy={loading || undefined}
          className={cn("tap-target min-w-avatar-action", offline && "opacity-50")}
          onPointerEnter={prefetch}
          onFocus={prefetch}
          onClick={openEditor}
          data-testid="profile-avatar-change"
        >
          {loading && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {loading ? AVATAR_ENTRY_COPY.opening : AVATAR_ENTRY_COPY.open}
        </Button>
      </div>
      <p id={hintId} className="text-meta text-ink-muted">
        {AVATAR_ENTRY_COPY.hint}
      </p>
      {/* 칸의 높이는 늘 예약해 두므로(min-h-6) 문장이 나타나도 아래 폼이 밀리지 않는다. */}
      <div className="min-h-6">
        <p
          role="status"
          aria-live="polite"
          className="text-meta text-ink-muted"
          data-testid="profile-avatar-status"
        >
          {loadFailed ? null : done}
        </p>
        {loadFailed ? (
          <p className="text-meta text-danger" role="alert" data-testid="profile-avatar-error">
            {AVATAR_ENTRY_COPY.loadFailed}
          </p>
        ) : null}
      </div>
      {Editor ? (
        <Editor
          key={session}
          open={open}
          onOpenChange={setOpen}
          workspaceId={workspaceId}
          me={me}
          offline={offline}
          opener={changeRef.current}
          onDone={setDone}
          onBusyChange={onBusyChange}
        />
      ) : null}
    </div>
  );
}
