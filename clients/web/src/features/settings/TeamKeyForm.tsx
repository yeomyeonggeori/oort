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
import { validateBaseUrl } from "./oauthGrant";

// =============================================================================
// 팀 키 폼 하나 (#2944 GC-3에서 옮김, #2880 AA-7).
//
// 채팅의 로컬 연결 카드와 설정 › AI 연결 곁판이 **이 컴포넌트 하나**를 쓴다. 프리셋
// 칩·password 칸·오프라인 잠금·대체 전 한 번 묻기·저장하면 칸 비우기가 두 표면에서
// 다르게 동작하면 안 되기 때문이다(교차 시험: `AiConnectCard.test.tsx`의
// 「같은 폼 · 같은 결과 문장: 설정 × 카드」).
// =============================================================================

/** 잠긴 버튼: 흐림이 포인터를 올려도 풀리지 않는다(variant의 hover:opacity-90을 덮는다). */
const LOCKED = "opacity-50 hover:opacity-50";

const KEY_HINT = "저장하면 다시 보이지 않아요. 마스킹 꼬리만 남아요. 이 칸의 값은 채팅·초안에 남지 않아요.";

/** 「직접 주소」 칩의 값. 서버 프리셋 id와 겹치지 않는 모양. */
const CUSTOM_ADDRESS = "__custom__";

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
  surface = "card",
  saveErrorHint,
  testIdPrefix = "ai-connect-card",
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
  /**
   * 어느 표면의 폼인가. 동작(칩·password 칸·잠금·대체 확인·저장)은 한 벌이고, 겉만
   * 각 시안을 따른다.
   * - `card`: 채팅 카드(chat-genui-connect 시안). 고른 칩은 채움, 칸 이름은 숨김.
   * - `settings`: 설정 곁판(ai-accounts 시안 §4 2b). 「provider」「API 키」 이름이 보이고,
   *   고른 칩은 테두리, 「직접 주소」 칩이 선다. 채팅 카드는 주소를 받지 않고 설정으로
   *   보낸다(#2944 GC-3).
   */
  surface?: "card" | "settings";
  /** 저장 오류 밑에 덧붙일 안내(설정의 loopback 안내). 없으면 서버 문장만. */
  saveErrorHint?: (error: unknown, baseUrl: string) => string | null;
  /** 시험 id 머리. 두 표면이 같은 폼을 서로 다른 이름으로 찾는다. */
  testIdPrefix?: string;
}) {
  const allowCustomAddress = surface === "settings";
  const presets = teamKeyPresets(link);
  const initial = initialPresetId(presets, link);
  // 프리셋이 없는 서버에서 주소를 받을 수 있는 표면이면 처음부터 직접 주소다.
  const [presetId, setPresetId] = useState<string | null>(() =>
    allowCustomAddress && initial === null && !link.configured ? CUSTOM_ADDRESS : initial
  );
  const [customUrl, setCustomUrl] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  // 이미 쓰는 키를 대체하기 전의 한 번 묻기. 키 값은 여전히 칸(DOM)에만 있다.
  const [confirmReplace, setConfirmReplace] = useState(false);
  const replacing = link.configured && link.keyConfigured;
  const inputRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef("");
  const inputId = useId();
  const urlId = useId();
  const urlHintId = useId();
  const urlErrorId = useId();
  const hintId = useId();
  const errorId = useId();
  const tid = (name: string) => `${testIdPrefix}-${name}`;

  const custom = presetId === CUSTOM_ADDRESS;

  useEffect(() => {
    (custom ? urlRef.current : inputRef.current)?.focus({ preventScroll: true });
    // 처음 한 번만: 칩을 바꿀 때마다 초점을 옮기지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preset = custom ? null : (presets.find((row) => row.id === presetId) ?? null);
  // 프리셋이 아닌 지금 주소(사내 프록시 등)는 「지금 주소」 칩으로 고른다. 조용히 첫
  // 프리셋으로 옮기지 않는다(review #2961 M4). 와이어는 저장된 format(N1).
  // 직접 주소는 OpenAI 호환 와이어다(칸의 안내가 그렇게 말한다).
  const target: { baseUrl: string; format: ProviderFormat } | null = custom
    ? { baseUrl: customUrl.trim(), format: "openai" }
    : preset
      ? { baseUrl: preset.baseUrl, format: preset.format }
      : link.configured
        ? { baseUrl: link.baseUrl, format: link.format ?? "openai" }
        : null;
  const movesAddress =
    link.configured && target !== null && target.baseUrl !== "" && trimSlash(target.baseUrl) !== trimSlash(link.baseUrl);
  const hasCurrentChip = link.configured && initial === null;
  const movesLabel = custom ? "새로 넣은" : preset ? preset.label : null;

  const client = useQueryClient();
  const mutationKey = useMemo(() => ["team-key-form", "save", inputId], [inputId]);
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

  function pick(id: string | null) {
    setPresetId(id);
    setConfirmReplace(false);
    setAddressError(null);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (offline || save.isPending || target === null) return;
    if (custom) {
      const bad = validateBaseUrl(customUrl);
      if (bad) {
        setAddressError(bad.message);
        urlRef.current?.focus();
        return;
      }
    }
    setAddressError(null);
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

  const chipClass = cn(
    "tap-target inline-flex h-control-sm min-w-0 max-w-full cursor-pointer items-center rounded-full border border-line px-3 text-meta font-semibold text-ink-muted peer-focus-visible:focus-ring",
    // 설정 시안의 고른 칩은 테두리(주 행동 「저장하고 확인」만 잉크 채움), 카드 시안은 채움.
    surface === "settings"
      ? "peer-checked:border-ink peer-checked:bg-surface peer-checked:text-ink"
      : "peer-checked:border-primary peer-checked:bg-primary peer-checked:text-on-primary"
  );
  const fieldLabel = surface === "settings" ? "text-meta font-semibold text-ink" : "sr-only";
  const showChips = presets.length > 0 || allowCustomAddress;
  const saveHint = save.isError && saveErrorHint ? saveErrorHint(save.error, target?.baseUrl ?? "") : null;

  return (
    <form
      className="flex min-w-0 flex-col gap-2 pb-1 pt-1"
      onSubmit={submit}
      // 주소 검사는 우리 문장이 한다(해요체, 칸 밑 오류 줄). 브라우저 말풍선이 먼저
      // 가로채지 않게 한다.
      noValidate
      autoComplete="off"
      data-form-type="other"
      data-testid={tid("key-form")}
      aria-label="팀 API 키 넣기"
    >
      {showChips ? (
        <fieldset className="flex min-w-0 flex-wrap gap-2">
          <legend className={cn(fieldLabel, surface === "settings" && "mb-1 w-full")}>
            {surface === "settings" ? "provider" : "API 제공자"}
          </legend>
          {hasCurrentChip && (
            <label className="press relative inline-flex min-w-0 max-w-full" title={link.endpointLabel}>
              <input
                type="radio"
                name={`${inputId}-preset`}
                value=""
                checked={presetId === null}
                onChange={() => pick(null)}
                className="peer sr-only"
                data-testid={tid("preset-current")}
              />
              <span className={chipClass}>
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
                onChange={() => pick(row.id)}
                className="peer sr-only"
                data-testid={tid(`preset-${row.id}`)}
              />
              <span className={chipClass}>{row.label}</span>
            </label>
          ))}
          {allowCustomAddress && (
            <label className="press relative inline-flex">
              <input
                type="radio"
                name={`${inputId}-preset`}
                value={CUSTOM_ADDRESS}
                checked={custom}
                onChange={() => pick(CUSTOM_ADDRESS)}
                className="peer sr-only"
                data-testid={tid("preset-custom")}
              />
              <span className={chipClass}>직접 주소</span>
            </label>
          )}
        </fieldset>
      ) : link.configured ? (
        <p className="break-keep text-meta text-ink-muted">지금 주소({link.endpointLabel})에 새 키를 넣어요.</p>
      ) : (
        <p className="break-keep text-meta text-ink-muted" data-testid={tid("no-presets")}>
          이 서버는 provider 목록을 주지 않아요. 주소는 AI의 팀 AI 키에서 넣어 주세요.
        </p>
      )}
      {custom && (
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={urlId} className="text-meta font-semibold text-ink">
            provider 주소
          </label>
          <Input
            id={urlId}
            ref={urlRef}
            name="team-provider-url"
            type="url"
            inputMode="url"
            value={customUrl}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="https://api.example.com/v1"
            aria-describedby={addressError ? `${urlErrorId} ${urlHintId}` : urlHintId}
            aria-invalid={addressError ? true : undefined}
            onChange={(event) => {
              setCustomUrl(event.target.value);
              setConfirmReplace(false);
            }}
            data-testid={tid("custom-url")}
          />
          {addressError && (
            <p id={urlErrorId} className="break-keep text-meta text-danger" role="alert">
              {addressError}
            </p>
          )}
          <p id={urlHintId} className="break-keep text-meta text-ink-muted">
            OpenAI 호환 주소만 받아요. 사내 프록시나 다른 provider를 쓸 때 넣어요.
          </p>
        </div>
      )}
      <label htmlFor={inputId} className={fieldLabel}>
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
        data-testid={tid("key-input")}
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
        <p className="break-keep text-meta text-danger" role="alert" data-testid={tid("save-error")}>
          {errorMessage(save.error)} 키는 칸에서 지웠으니 다시 붙여 넣어 주세요.
        </p>
      )}
      {saveHint && (
        <p className="break-keep text-meta text-ink-muted" data-testid={tid("save-hint")}>
          {saveHint}
        </p>
      )}
      {confirmReplace && (
        <p className="break-keep text-meta text-warn" role="alert" data-testid={tid("key-replace")}>
          지금 팀 기본 키({maskedBearer(link.bearerLast4)})를 이 키로 바꿔요.
          {movesAddress && movesLabel ? ` 주소도 ${movesLabel} 주소로 바뀌어요.` : ""} 팀 에이전트는 바로 새 키로 대답해요.
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
          data-testid={tid("key-save")}
        >
          {save.isPending ? "저장 중" : confirmReplace ? "바꿔 저장하고 확인" : "저장하고 확인"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} data-testid={tid("key-cancel")}>
          취소
        </Button>
      </div>
    </form>
  );
}
