import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  devAccessError,
  type DevPresetId,
  type DevTool,
} from "@momo/core/features/auth/devAccess";
import {
  DEV_CHANNEL_RESTRICTION_COPY,
  DEV_DEFAULT_PRESET,
  DEV_EXPIRY_CHOICES,
  DEV_EXPIRY_DEFAULT_DAYS,
  DEV_EXPIRY_MAX_DAYS,
  DEV_NAME_MAX_LENGTH,
  DEV_NOTICES,
  DEV_PASSWORD_MAX_LENGTH,
  DEV_PRESETS,
  DEV_TOOL_CHOICES,
  defaultDevCredentialName,
  devAccessErrorText,
  devExpiryChoiceLabel,
  devToolLabel,
  validateChannelSelection,
  validateDevName,
  validateExpiryDays,
  validatePassword,
} from "@momo/core/features/auth/devAccessModel";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { SegmentedControl } from "@/design/ui/segmented-control";
import { InlineBanner } from "@/features/common/States";
import { DevAccessChannelPicker } from "./DevAccessChannelPicker";
import { DevAccessReveal } from "./DevAccessReveal";
import {
  createDevCredentialFn,
  DEV_CREDENTIAL_MUTATION_SCOPE,
  devCredentialsQueryPrefix,
  purgeDevCredentials,
  type CreateDevCredentialVariables,
} from "./devAccessQuery";
import { SecretInput } from "./SecretInput";
import { ChoiceRadios, Field, SelectField, SettingsToggleRow } from "./SettingsFields";
import { SettingsSection } from "./shell/SettingsSection";

// Reading this as: settings for internal team users on web+Tauri,
// density 6/10, motion 2/10.

// =============================================================================
// 새 연결 만들기 (#4663, ADR-0216 D2 D3 D6). 이름, 쓰는 도구, 범위, (고른 채널만), 만료, 그리고
// **현재 비밀번호를 다시** 받아 연결 값 하나를 만든다. 값은 `DevAccessReveal` 다이얼로그에 한 번만
// 선다.
//
// ## 비밀이 사는 곳
// - 연결 값: 이 컴포넌트의 만들기 뮤테이션 결과(`create.data`) 하나뿐이다. 쿼리 캐시·저장소·주소에
//   넣지 않는다. 지우는 행위는 「저장했어요」가 부르는 `create.reset()`이다(`done`).
// - 비밀번호: 칸의 상태는 **보내는 순간** 비워진다. 뮤테이션 변수에는 평문이 아니라 한 번 쓰고
//   비워지는 상자(`PasswordBox`)가 간다. 틀려도 칸은 비어 있고 오류는 그 칸에 묶인다.
// 둘 다 `devAccessQuery.ts` 머리말이 이유를 적는다.
//
// ## 가드는 폼이 진다
// 진행은 `aria-busy` + 바뀐 낱말이고 `disabled`가 아니다(초점을 놓지 않는다). 오프라인은 잠금이다:
// `aria-disabled` + 흐림 + 사유 + 가드. 두 번째 Enter는 `submit`이 삼킨다.
// =============================================================================

const OFFLINE_NOTE_ID = "dev-access-create-offline-note";
const OFFLINE_CREATE_REASON =
  "연결이 끊겨 지금은 연결을 만들 수 없어요. 다시 연결된 뒤에 눌러 주세요.";

const NAME_HINT = "목록에서 이 연결을 알아볼 수 있는 이름이에요.";
const PASSWORD_HINT = "연결을 만들 때마다 한 번 더 확인해요. 이 값은 저장하지 않아요.";
const EXPIRY_HINT = `만료일이 지나면 이 연결은 저절로 끊겨요. ${DEV_NOTICES.fixedAfterIssue}`;
const DAYS_HINT = `1일부터 ${DEV_EXPIRY_MAX_DAYS}일까지 정할 수 있어요.`;

const DAYS_FIELD_ID = "dev-access-days";
const PASSWORD_FIELD_ID = "dev-access-password";
const CHANNEL_ERROR_ID = "dev-access-channels-error-text";

/** 만료 선택칸의 마지막 항목. 고르면 일수를 직접 쓰는 칸이 선다. */
const CUSTOM_EXPIRY = "custom";

const EXPIRY_CHOICES = [
  ...DEV_EXPIRY_CHOICES.map((days) => ({
    id: String(days),
    label: devExpiryChoiceLabel(days),
  })),
  { id: CUSTOM_EXPIRY, label: "직접 정하기" },
];

const TOOL_OPTIONS = DEV_TOOL_CHOICES.map((tool) => ({
  value: tool,
  label: devToolLabel(tool),
}));

const PRESET_CHOICES = DEV_PRESETS.map((preset) => ({
  id: preset.id,
  label: preset.label,
  detail: preset.description,
}));

const DEFAULT_TOOL: DevTool = DEV_TOOL_CHOICES[0];

interface FieldErrors {
  name?: string;
  days?: string;
  channels?: string;
  password?: string;
}

export function DevAccessCreateForm({
  workspaceId,
  memberId,
  offline,
  gateText,
  nameFieldId,
  onSaved,
  onRevealChange,
}: {
  workspaceId: string;
  memberId: string;
  offline: boolean;
  /** 이 스위치에서 누가 만들 수 있는지 한 문장(코어). 카드 설명으로 선다. */
  gateText: string;
  nameFieldId: string;
  /** 「저장했어요」 뒤. 이름만 건넨다. 값은 이미 지워졌다. */
  onSaved: (name: string) => void;
  /**
   * 값 화면이 서 있는지 부모에게 알린다. 값의 유일한 보관처가 이 폼의 뮤테이션이라서, 부모는 값 화면이 떠
   * 있는 동안(정책이 다시 읽혀 문이 닫혔다고 해도) 이 폼을 거두지 않는다. 사라질 때는 항상 false로 알린다.
   */
  onRevealChange: (up: boolean) => void;
}) {
  const client = useQueryClient();
  const createButtonRef = useRef<HTMLButtonElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const channelsRef = useRef<HTMLDivElement | null>(null);
  const nameEdited = useRef(false);

  const [tool, setTool] = useState<DevTool>(DEFAULT_TOOL);
  const [name, setName] = useState(() => defaultDevCredentialName(DEFAULT_TOOL));
  const [preset, setPreset] = useState<DevPresetId>(DEV_DEFAULT_PRESET);
  const [restrict, setRestrict] = useState(false);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState(String(DEV_EXPIRY_DEFAULT_DAYS));
  const [customDays, setCustomDays] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  const create = useMutation({
    ...DEV_CREDENTIAL_MUTATION_SCOPE,
    // 이 모듈 밖(`devAccessQuery`)에서 만든 함수다: 렌더 안의 클로저는 방금 친 비밀번호를 붙잡는다.
    mutationFn: createDevCredentialFn(workspaceId),
  });

  // 화면이 사라지면 캐시에 남은 연결 값 뮤테이션을 동기로 비운다(`gcTime: 0`은 다음 틱을 기다린다).
  useEffect(() => () => void purgeDevCredentials(client), [client]);

  const revealUp = create.data !== undefined;
  useEffect(() => {
    onRevealChange(revealUp);
  }, [revealUp, onRevealChange]);
  useEffect(() => () => onRevealChange(false), [onRevealChange]);

  const failure = create.isError ? devAccessError(create.error) : null;

  // 틀린 비밀번호만 칸에 묶인다. 나머지 실패는 아래 배너다(종류마다 문장이 다르다).
  useEffect(() => {
    if (!create.isError) return;
    const found = devAccessError(create.error);
    if (found.kind !== "password_incorrect") return;
    setErrors((current) => ({ ...current, password: devAccessErrorText(found, "create") }));
    passwordRef.current?.focus();
  }, [create.isError, create.error]);

  function clearError(key: keyof FieldErrors) {
    setErrors((current) => (current[key] === undefined ? current : { ...current, [key]: undefined }));
  }

  function pickTool(next: DevTool) {
    setTool(next);
    // 이름 칸의 시작값은 도구 이름이다. 사람이 한 글자라도 고쳤으면 도구를 바꿔도 그대로 둔다.
    if (!nameEdited.current) setName(defaultDevCredentialName(next));
  }

  function resetDraft() {
    nameEdited.current = false;
    setTool(DEFAULT_TOOL);
    setName(defaultDevCredentialName(DEFAULT_TOOL));
    setPreset(DEV_DEFAULT_PRESET);
    setRestrict(false);
    setChannelIds([]);
    setExpiry(String(DEV_EXPIRY_DEFAULT_DAYS));
    setCustomDays("");
    setPassword("");
    setErrors({});
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // `aria-disabled`는 클릭도 Enter도 막지 않으므로(초점을 잃지 않는 것이 요점이다) 거절은 여기서
    // 한다. 이름 칸에서 누른 Enter(암묵적 제출)도 같은 길이라 `onClick`이 아니라 폼이 가드를 진다.
    if (offline || create.isPending) return;

    const nameCheck = validateDevName(name);
    const daysCheck =
      expiry === CUSTOM_EXPIRY ? validateExpiryDays(customDays) : validateExpiryDays(Number(expiry));
    const channelCheck = restrict ? validateChannelSelection(channelIds) : null;
    const passwordCheck = validatePassword(password);

    const found: FieldErrors = {
      ...(nameCheck.ok ? {} : { name: nameCheck.message }),
      ...(daysCheck.ok ? {} : { days: daysCheck.message }),
      ...(channelCheck === null || channelCheck.ok ? {} : { channels: channelCheck.message }),
      ...(passwordCheck.ok ? {} : { password: passwordCheck.message }),
    };
    if (!nameCheck.ok || !daysCheck.ok || !passwordCheck.ok || (channelCheck && !channelCheck.ok)) {
      setErrors(found);
      const target = found.name
        ? document.getElementById(nameFieldId)
        : found.days
          ? document.getElementById(DAYS_FIELD_ID)
          : found.channels
            ? channelsRef.current?.querySelector<HTMLElement>("input")
            : passwordRef.current;
      target?.focus();
      return;
    }

    setErrors({});
    // 비밀번호는 상자에 옮겨 담고 칸의 상태를 **먼저** 비운다. 요청이 날고 있는 동안에도,
    // 틀려서 돌아온 뒤에도 칸에는 아무것도 남지 않는다.
    const box = { value: passwordCheck.value };
    setPassword("");
    const variables: CreateDevCredentialVariables = {
      input: {
        name: nameCheck.value,
        tool,
        preset,
        ...(channelCheck?.ok ? { channelIds: channelCheck.value } : {}),
        expiresInDays: daysCheck.value,
      },
      password: box,
    };
    create.mutate(variables);
  }

  function done() {
    const createdName = create.data?.name ?? "";
    // 값을 지우는 행위는 이것이다. 뮤테이션이 결과를 놓으면 다이얼로그가 선 조건(`create.data`)이
    // 사라지고, 캐시의 사본까지 같은 자리에서 비운다.
    create.reset();
    purgeDevCredentials(client);
    resetDraft();
    void client.invalidateQueries({ queryKey: devCredentialsQueryPrefix(workspaceId) });
    onSaved(createdName);
  }

  const bannerText =
    failure !== null && failure.kind !== "password_incorrect"
      ? devAccessErrorText(failure, "create")
      : null;

  return (
    <>
      <SettingsSection title="새 연결 만들기" description={gateText} testId="dev-access-create-card">
        <form
          className="flex min-w-0 flex-col divide-y divide-line"
          onSubmit={submit}
          data-testid="dev-access-create-form"
        >
          <div className="px-4 py-3">
            <Field label="이름" htmlFor={nameFieldId} hint={NAME_HINT} error={errors.name}>
              <Input
                id={nameFieldId}
                name="devAccessName"
                type="text"
                autoComplete="off"
                maxLength={DEV_NAME_MAX_LENGTH}
                value={name}
                onChange={(event) => {
                  nameEdited.current = true;
                  setName(event.target.value);
                  clearError("name");
                }}
                data-testid="dev-access-name"
              />
            </Field>
          </div>

          <div className="flex min-w-0 flex-col gap-2 px-4 py-3">
            {/* 눈에 보이는 이름표다. 낭독은 아래 그룹의 `legend`가 하므로 겹쳐 읽지 않게 숨긴다. */}
            <p aria-hidden="true" className="text-meta text-ink-muted">
              쓰는 도구
            </p>
            <SegmentedControl
              legend="쓰는 도구"
              name="dev-access-tool"
              options={TOOL_OPTIONS}
              value={tool}
              onValueChange={pickTool}
              testId="dev-access-tool"
            />
            <p className="break-keep text-meta text-ink-muted" data-testid="dev-access-tool-note">
              {DEV_NOTICES.toolIsOnlyALabel}
            </p>
          </div>

          <div className="p-4">
            <ChoiceRadios
              name="dev-access-preset"
              legend="범위"
              choices={PRESET_CHOICES}
              value={preset}
              onChange={(id) => setPreset(id === "read_write" ? "read_write" : "read")}
              busy={create.isPending}
              testId="dev-access-preset"
            />
          </div>

          <div className="flex min-w-0 flex-col gap-3 p-4">
            <div className="overflow-hidden rounded-md border border-line">
              <SettingsToggleRow
                testId="dev-access-restrict"
                name={DEV_CHANNEL_RESTRICTION_COPY.label}
                description={DEV_CHANNEL_RESTRICTION_COPY.help}
                checked={restrict}
                onToggle={(next) => {
                  setRestrict(next);
                  if (!next) clearError("channels");
                }}
              />
            </div>
            {restrict && (
              <div ref={channelsRef} className="flex min-w-0 flex-col gap-2">
                <DevAccessChannelPicker
                  workspaceId={workspaceId}
                  memberId={memberId}
                  selected={channelIds}
                  onChange={(next) => {
                    setChannelIds(next);
                    clearError("channels");
                  }}
                  describedBy={errors.channels ? CHANNEL_ERROR_ID : undefined}
                />
                {errors.channels && (
                  <p
                    id={CHANNEL_ERROR_ID}
                    className="break-keep text-meta text-danger"
                    role="alert"
                    data-testid="dev-access-channels-validation"
                  >
                    {errors.channels}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-3 px-4 py-3">
            <SelectField
              id="dev-access-expiry"
              label="만료"
              // `SelectField`의 힌트 문단은 어절 끊기가 없어 한국어가 음절 중간에서 꺾인다(390px 실측).
              hint={<span className="break-keep">{EXPIRY_HINT}</span>}
              value={expiry}
              choices={EXPIRY_CHOICES}
              onChange={(id) => {
                setExpiry(id);
                clearError("days");
              }}
              testId="dev-access-expiry"
            />
            {expiry === CUSTOM_EXPIRY && (
              <Field label="만료 기간(일)" htmlFor={DAYS_FIELD_ID} hint={DAYS_HINT} error={errors.days}>
                <Input
                  id={DAYS_FIELD_ID}
                  name="devAccessDays"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={customDays}
                  onChange={(event) => {
                    setCustomDays(event.target.value);
                    clearError("days");
                  }}
                  className="w-full max-w-pane"
                  data-testid="dev-access-days"
                />
              </Field>
            )}
          </div>

          <div className="px-4 py-3">
            <Field
              label="현재 비밀번호"
              htmlFor={PASSWORD_FIELD_ID}
              hint={PASSWORD_HINT}
              error={errors.password}
            >
              <SecretInput
                ref={passwordRef}
                id={PASSWORD_FIELD_ID}
                name="devAccessPassword"
                autoComplete="current-password"
                maxLength={DEV_PASSWORD_MAX_LENGTH}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  clearError("password");
                }}
                revealTestId="dev-access-password-reveal"
                data-testid="dev-access-password"
              />
            </Field>
          </div>

          {bannerText !== null && (
            <div className="px-4 py-3">
              <InlineBanner
                message={bannerText}
                className="px-0"
                separator={false}
                testId="dev-access-create-error"
              />
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 px-4 py-3">
            {/* 잠긴 컨트롤은 사유를 든다. 회색이 혼자 서면 「권한이 없다」로 읽히는데 이 사람은 만들 수 있고
                지금 연결이 끊겨 있을 뿐이다. 다시 연결된 뒤 한 번 더 눌러야 한다(오프라인 큐는 없다). */}
            {offline && (
              <span
                id={OFFLINE_NOTE_ID}
                className="min-w-0 flex-1 break-keep text-meta text-ink-muted"
                data-testid="dev-access-create-offline"
              >
                {OFFLINE_CREATE_REASON}
              </span>
            )}
            <Button
              ref={createButtonRef}
              type="submit"
              size="sm"
              aria-disabled={offline || undefined}
              aria-busy={create.isPending || undefined}
              aria-describedby={offline ? OFFLINE_NOTE_ID : undefined}
              className={cn(offline && "opacity-50")}
              data-testid="dev-access-create"
            >
              {create.isPending ? "만드는 중" : "연결 만들기"}
            </Button>
          </div>
        </form>
      </SettingsSection>

      {create.data !== undefined && (
        <DevAccessReveal
          created={create.data}
          workspaceId={workspaceId}
          opener={createButtonRef.current}
          onDone={done}
        />
      )}
    </>
  );
}
