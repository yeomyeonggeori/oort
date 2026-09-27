import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  putProviderLink,
  type ProviderFormat,
  type ProviderLink,
} from "@momo/core/features/settings/api";
import { errorMessage, maskedBearer } from "@momo/core/features/settings/model";
import { initialPresetId, teamKeyPresets } from "@momo/core/features/settings/teamKeyForm";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";

// =============================================================================
// 팀 키 폼 하나 (#2944 GC-3에서 옮김, #2880 AA-7).
//
// 채팅의 로컬 연결 카드와 설정 › AI 연결 곁판이 **이 컴포넌트 하나**를 쓴다. 프리셋
// 칩·password 칸·오프라인 잠금·대체 전 한 번 묻기·저장하면 칸 비우기가 두 표면에서
// 다르게 동작하면 안 되기 때문이다(교차 시험 `teamKeyForm.cross.test.tsx`).
// =============================================================================

/** 잠긴 버튼: 흐림이 포인터를 올려도 풀리지 않는다(variant의 hover:opacity-90을 덮는다). */
const LOCKED = "opacity-50 hover:opacity-50";

const KEY_HINT = "저장하면 다시 보이지 않아요. 마스킹 꼬리만 남아요. 이 칸의 값은 채팅·초안에 남지 않아요.";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * 팀 키 넣기(운영자). 프리셋 칩 + 마스킹 칸 + 「저장하고 확인」.
 *
 * 순서가 이름이다(design-review #2944 H1): 지금 서버에는 저장 전 판정 경로가
 * 없어서(#2880·#2872) 저장한 뒤에 확인한다. 그래서 이미 쓰는 키가 있으면 대체하기
 * 전에 한 번 묻는다: 확인 없이 잘 되던 팀 키를 덮어쓰지 않게.
 *
 * 키는 **비제어** 칸의 DOM 값이다. React 상태에도, 뮤테이션 변수에도 싣지 않는다:
 * `useMutation`은 마지막 변수를 캐시에 들고 있으므로 변수에 키를 넣으면 저장 뒤에도
 * 메모리에 남는다. 저장을 누르는 순간 칸을 비우고 PUT 한 번에 넘긴다.
 *
 * 오프라인(review #2961 H1): react-query v5 뮤테이션의 기본 `networkMode: "online"`은
 * 끊긴 동안 fn을 부르지 않고 멈춰 두었다가 다시 이어지면 조용히 보낸다. 그러면 키가
 * 클로저에 남고, 카드를 닫은 뒤에 팀 키가 바뀐다. 그래서 ① 끊겼으면 저장 전에
 * 막고(설정 `saveLocked`와 같은 규칙), ② `networkMode: "always"`로 누른 순간 한 번만
 * 시도하며(실패는 제자리 오류 줄), ③ 폼이 사라지면 멈춘 저장과 붙잡은 값을 버린다.
 *
 * 비밀번호 관리자(review #2961 M3): 칸은 password 그대로다. text + 가림 글꼴은
 * 접근성 트리에 값을 평문으로 내보내므로 쓰지 않는다(design-review #2961 H1).
 * 저장 제안은 `autocomplete="new-password"`와 관리자별 무시 속성으로 막는다.
 */
export function TeamKeyForm({
  link,
  offline,
  offlineNoteId,
  currentFailed,
  onCancel,
  onSaved,
}: {
  link: ProviderLink;
  /** 연결이 끊겼는가. 끊겼으면 저장을 누르기 전에 막는다(review #2961 H1). */
  offline: boolean;
  /** 끊긴 사유 문장의 id(저장 버튼의 aria-describedby). */
  offlineNoteId: string;
  /** 지금 키가 방금 확인에 실패했는가(대체 경고의 문장이 달라진다). */
  currentFailed: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const presets = teamKeyPresets(link);
  const [presetId, setPresetId] = useState<string | null>(() => initialPresetId(presets, link));
  const [fieldError, setFieldError] = useState<string | null>(null);
  // 이미 쓰는 키를 대체하기 전의 한 번 묻기. 키 값은 여전히 칸(DOM)에만 있다.
  const [confirmReplace, setConfirmReplace] = useState(false);
  const replacing = link.configured && link.keyConfigured;
  const inputRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef("");
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const preset = presets.find((row) => row.id === presetId) ?? null;
  // 프리셋이 아닌 지금 주소(사내 프록시 등)는 「지금 주소」 칩으로 고른다. 조용히 첫
  // 프리셋으로 옮기지 않는다(review #2961 M4). 와이어는 저장된 format(N1).
  const target: { baseUrl: string; format: ProviderFormat } | null = preset
    ? { baseUrl: preset.baseUrl, format: preset.format }
    : link.configured
      ? { baseUrl: link.baseUrl, format: link.format ?? "openai" }
      : null;
  const movesAddress =
    link.configured && target !== null && trimSlash(target.baseUrl) !== trimSlash(link.baseUrl);
  const hasCurrentChip = link.configured && initialPresetId(presets, link) === null;

  const client = useQueryClient();
  const mutationKey = useMemo(() => ["ai-connect-card", "team-key-save", inputId], [inputId]);
  const save = useMutation({
    mutationKey,
    // 누른 순간 한 번만 시도한다: 끊긴 동안 멈춰 두었다가 나중에 보내지 않는다.
    networkMode: "always",
    mutationFn: (input: { baseUrl: string; format: ProviderFormat }) => {
      const bearer = secretRef.current;
      secretRef.current = "";
      return putProviderLink({ baseUrl: input.baseUrl, bearer, mode: "external-hermes", format: input.format });
    },
    onSuccess: onSaved,
  });

  // 폼이 사라지면(취소·Esc·카드 닫기·채널 이동) 붙잡은 값과 멈춘 저장을 버린다.
  useEffect(
    () => () => {
      secretRef.current = "";
      const cache = client.getMutationCache();
      for (const mutation of cache.findAll({ mutationKey, exact: true })) {
        if (mutation.state.isPaused) cache.remove(mutation);
      }
    },
    [client, mutationKey]
  );

  const locked = offline || target === null || save.isPending;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (offline || save.isPending || target === null) return;
    const field = inputRef.current;
    const value = field?.value.trim() ?? "";
    if (value === "") {
      setFieldError("키를 붙여 넣으세요. 저장된 키는 다시 내려오지 않아서 매번 새로 넣어요.");
      field?.focus();
      return;
    }
    setFieldError(null);
    if (replacing && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    setConfirmReplace(false);
    secretRef.current = value;
    if (field) field.value = "";
    save.mutate(target);
  }

  return (
    <form
      className="flex min-w-0 flex-col gap-2 pb-1 pt-1"
      onSubmit={submit}
      autoComplete="off"
      data-form-type="other"
      data-testid="ai-connect-card-key-form"
      aria-label="팀 API 키 넣기"
    >
      {presets.length > 0 ? (
        <fieldset className="flex min-w-0 flex-wrap gap-2">
          <legend className="sr-only">API 제공자</legend>
          {hasCurrentChip && (
            <label className="press relative inline-flex min-w-0 max-w-full" title={link.endpointLabel}>
              <input
                type="radio"
                name={`${inputId}-preset`}
                value=""
                checked={presetId === null}
                onChange={() => {
                  setPresetId(null);
                  setConfirmReplace(false);
                }}
                className="peer sr-only"
                data-testid="ai-connect-card-preset-current"
              />
              <span className="tap-target inline-flex h-control-sm min-w-0 max-w-full cursor-pointer items-center rounded-full border border-line px-3 text-meta font-semibold text-ink-muted peer-checked:border-primary peer-checked:bg-primary peer-checked:text-on-primary peer-focus-visible:focus-ring">
                <span className="truncate">지금 주소 · {link.endpointLabel}</span>
              </span>
            </label>
          )}
          {presets.map((row) => (
            <label key={row.id} className="press relative inline-flex">
              <input
                type="radio"
                name={`${inputId}-preset`}
                value={row.id}
                checked={presetId === row.id}
                onChange={() => {
                  setPresetId(row.id);
                  setConfirmReplace(false);
                }}
                className="peer sr-only"
                data-testid={`ai-connect-card-preset-${row.id}`}
              />
              <span className="tap-target inline-flex h-control-sm cursor-pointer items-center rounded-full border border-line px-3 text-meta font-semibold text-ink-muted peer-checked:border-primary peer-checked:bg-primary peer-checked:text-on-primary peer-focus-visible:focus-ring">
                {row.label}
              </span>
            </label>
          ))}
        </fieldset>
      ) : link.configured ? (
        <p className="break-keep text-meta text-ink-muted">지금 주소({link.endpointLabel})에 새 키를 넣어요.</p>
      ) : (
        <p className="break-keep text-meta text-ink-muted" data-testid="ai-connect-card-no-presets">
          이 서버는 provider 목록을 주지 않아요. 주소는 설정 › AI 연결에서 넣어 주세요.
        </p>
      )}
      <label htmlFor={inputId} className="sr-only">
        API 키
      </label>
      <Input
        id={inputId}
        ref={inputRef}
        type="password"
        name="team-api-key"
        autoComplete="new-password"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        data-bwignore=""
        data-form-type="other"
        placeholder="키를 붙여 넣으세요"
        className="font-mono"
        aria-describedby={fieldError ? `${errorId} ${hintId}` : hintId}
        aria-invalid={fieldError ? true : undefined}
        onInput={() => setConfirmReplace(false)}
        data-testid="ai-connect-card-key-input"
      />
      {fieldError && (
        <p id={errorId} className="break-keep text-meta text-danger" role="alert">
          {fieldError}
        </p>
      )}
      <p id={hintId} className="break-keep text-meta text-ink-muted">
        {KEY_HINT}
      </p>
      {save.isError && (
        <p className="break-keep text-meta text-danger" role="alert" data-testid="ai-connect-card-save-error">
          {errorMessage(save.error)} 키는 칸에서 지웠으니 다시 붙여 넣어 주세요.
        </p>
      )}
      {confirmReplace && (
        <p className="break-keep text-meta text-warn" role="alert" data-testid="ai-connect-card-key-replace">
          지금 팀 기본 키({maskedBearer(link.bearerLast4)})를 이 키로 바꿔요.
          {movesAddress && preset ? ` 주소도 ${preset.label} 주소로 바뀌어요.` : ""} 팀 에이전트는 바로 새 키로 대답해요.
          {currentFailed
            ? " 지금 키는 방금 확인에 실패했어요. 새 키도 저장한 뒤에 확인해요."
            : " 저장한 뒤에 확인하니, 틀린 키면 팀 에이전트가 멈춰요."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          aria-busy={save.isPending || undefined}
          aria-disabled={locked || undefined}
          aria-describedby={offline ? offlineNoteId : undefined}
          className={cn(locked && LOCKED)}
          data-testid="ai-connect-card-key-save"
        >
          {save.isPending ? "저장 중" : confirmReplace ? "바꿔 저장하고 확인" : "저장하고 확인"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} data-testid="ai-connect-card-key-cancel">
          취소
        </Button>
      </div>
    </form>
  );
}
