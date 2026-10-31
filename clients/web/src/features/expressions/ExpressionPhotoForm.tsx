import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "@momo/core/lib/api";
import type { MessageKey } from "@momo/core/i18n";
import {
  AI_SETTINGS_PATH,
  PHOTO_BRANCHES,
  PHOTO_PROVIDERS,
  buildPhotoMetadata,
  expressionActivateRequest,
  isPhotoMetadata,
  photoDraftRequest,
  photoFailureOf,
  type PhotoBranch,
  type PhotoDraftResult,
  type PhotoFailure,
  type PhotoModel,
} from "@momo/core/features/expressions/photo";
import type { ExpressionMetadata } from "@momo/core/features/expressions/types";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { Select } from "@/design/ui/select";
import { SegmentedControl } from "@/design/ui/segmented-control";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { loadCatalog } from "@/features/emoji/catalog";
import { useAppLocale } from "@/i18n/localeContext";
import { EXPRESSION_FILE_ACCEPT, validExpressionFile } from "./media";
import { useExpressions } from "./context";
import { ExpressionDraftCard } from "./ExpressionDraftCard";
import { ExpressionHttpError } from "./transport";

// =============================================================================
// 사진으로 만들기 (ADR-0218 §8 H9, #4941): 사진 한 장을 서버가 팀에 연결된 이미지 모델(OpenAI·
// Gemini)에 보내 「배경 지우기」나 「캐리커처」 그림을 받아 오고, 그 그림이 직접 올리기와 같은
// 초안 카드로 돌아온다. 이 양식의 책임은 다섯 가지다:
//   1. 모델이 있는지 먼저 묻고, 없으면 만들지 않고 연결하라고 안내한다(등록은 가져오기로 늘 된다).
//   2. 사진이 어느 회사로 가는지 말하고 동의를 받는다(동의한 회사가 요청에 실린다).
//   3. 갈래(배경 지우기/캐리커처)와 이름·얼굴 선언을 받는다.
//   4. 한 번 보내고(최대 2분), 실패는 닫힌 코드에 맞는 한 줄로 말한다.
//   5. 서버가 만든 그림을 그대로 보여 주고 승인을 받는다.
// 모든 문장은 i18n 사전(`expressions.photo.*`)에서 온다. 상태 이름·요청 모양은 이 파일에 문자열로
// 두지 않는다(직접 문구 장부): 숫자 상태와 코어의 요청 생성기를 쓴다.
// =============================================================================

/** 양식이 있는 자리. 이름은 속성 이름이라 문구로 세지지 않는다. */
const Step = { idle: 0, busy: 1, failed: 2, made: 3 } as const;
const Check = { loading: 0, error: 1, ready: 2 } as const;
const Face = { none: 0, self: 1, other: 2 } as const;

type ModelState = { kind: typeof Check.loading } | { kind: typeof Check.error } | { kind: typeof Check.ready; model: PhotoModel };
type Phase = { kind: typeof Step.idle } | { kind: typeof Step.busy } | { kind: typeof Step.failed; failure: PhotoFailure } | { kind: typeof Step.made; result: PhotoDraftResult };
interface Invalid { photo?: string; consent?: string; fields?: string; face?: string }

const FAILURE_KEY = {
  unavailable: "expressions.photo.errorUnavailable",
  changed: "expressions.photo.errorChanged",
  refused: "expressions.photo.errorRefused",
  failed: "expressions.photo.errorFailed",
  timeout: "expressions.photo.errorTimeout",
  busy: "expressions.photo.errorBusy",
  quota: "expressions.photo.errorQuota",
  role: "expressions.photo.errorRole",
  name: "expressions.photo.errorName",
  media: "expressions.photo.errorMedia",
  too_large: "expressions.photo.photoSize",
  offline: "expressions.photo.errorOffline",
  generic: "expressions.photo.errorGeneric",
} as const satisfies Record<PhotoFailure, MessageKey>;

const CUTOUT_KEY = {
  model: "expressions.photo.cutoutModel",
  erased: "expressions.photo.cutoutErased",
  unchanged: "expressions.photo.cutoutUnchanged",
} as const satisfies Record<string, MessageKey>;

function failureOf(error: unknown): PhotoFailure {
  if (error instanceof ExpressionHttpError) return photoFailureOf(error.status, error.code);
  if (error instanceof ApiError) return photoFailureOf(error.status, error.code);
  // 시간 초과(중단)와 연결 실패는 상태가 없다: 오프라인으로 말한다.
  return photoFailureOf(undefined, undefined);
}

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function ExpressionPhotoForm({ onImport, onAgent, onDone, onClose }: { onImport: () => void; onAgent: () => void; onDone: () => void; onClose?: () => void }) {
  const { store, offline } = useExpressions();
  const locale = useAppLocale();
  // 사전을 거치는 호출은 모두 이 이름으로 한다: 장부가 키를 사전과 대조한다. 사전이 아직 없는
  // 화면(부팅 전 고립 시험)에서는 키 자체가 보인다.
  const formatMessage = (key: MessageKey, args?: Record<string, string>): string =>
    locale ? (locale.service.formatMessage as (key: string, args?: Record<string, string>) => string)(key, args) : key;
  const navigate = useNavigate();
  const ids = { photo: useId(), name: useId(), display: useId(), tags: useId(), face: useId() };
  const [modelState, setModelState] = useState<ModelState>({ kind: Check.loading });
  const [tries, setTries] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [cutout, caricature] = PHOTO_BRANCHES;
  const [branch, setBranch] = useState<PhotoBranch>(cutout);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [tags, setTags] = useState("");
  const [face, setFace] = useState<number>(Face.none);
  const [consent, setConsent] = useState(false);
  const [invalid, setInvalid] = useState<Invalid>({});
  const [phase, setPhase] = useState<Phase>({ kind: Step.idle });
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    if (!store) return;
    let live = true;
    setModelState({ kind: Check.loading });
    store.photoModel().then((model) => { if (live) setModelState({ kind: Check.ready, model }); }, () => { if (live) setModelState({ kind: Check.error }); });
    return () => { live = false; };
  }, [store, tries]);

  useEffect(() => {
    if (file === null) { setPreview(null); return; }
    let live = true;
    fileDataUrl(file).then((src) => { if (live) setPreview(src); }, () => { if (live) setPreview(null); });
    return () => { live = false; };
  }, [file]);

  if (!store) return null;
  const busy = phase.kind === Step.busy;

  if (phase.kind === Step.made) {
    const { draft, cutout: done } = phase.result;
    return <div className="flex min-h-0 max-h-pane-lg flex-col gap-2 overflow-y-auto" data-testid="expression-photo-made">
      {done !== null && <p role="status" className="break-keep text-meta text-ink-muted" data-testid="expression-photo-cutout" data-cutout={done}>{formatMessage(CUTOUT_KEY[done])}</p>}
      <ExpressionDraftCard draft={draft} promptLabel={formatMessage("expressions.photo.originLabel")} onReplace={(next) => setPhase({ kind: Step.made, result: { draft: next, cutout: done } })} onApprove={async (choice) => { await store.mutate(expressionActivateRequest(store.base, choice)); onDone(); }} />
      <Button type="button" variant="ghost" onClick={() => { setPhase({ kind: Step.idle }); setConsent(false); }} data-testid="expression-photo-again">{formatMessage("expressions.photo.anotherPhoto")}</Button>
    </div>;
  }

  if (modelState.kind === Check.loading) return <div className="flex flex-col gap-2" data-testid="expression-photo-checking"><p className="text-meta text-ink-muted">{formatMessage("expressions.photo.checking")}</p><Skeleton ready={false} rows={2} /></div>;
  if (modelState.kind === Check.error) {
    // 확인이 안 될 때도 에이전트에게 부탁하는 길은 막지 않는다: 그 길은 이 확인과 상관없다.
    return <div className="flex flex-col gap-2">
      <InlineBanner message={formatMessage("expressions.photo.checkFailed")} actionLabel={formatMessage("expressions.photo.retry")} onAction={() => setTries((value) => value + 1)} separator={false} className="px-0" testId="expression-photo-check-error" />
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onAgent} data-testid="expression-photo-agent">{formatMessage("expressions.photo.agentInstead")}</Button>
    </div>;
  }
  const { model } = modelState;
  if (!model.available || model.provider === null) {
    return <EmptyInvite headline={formatMessage("expressions.photo.noModelHeadline")} detail={formatMessage("expressions.photo.noModelDetail")} className="px-0 py-3" testId="expression-photo-no-model" actions={<>
      {model.canManage
        ? <Button type="button" variant="secondary" onClick={() => { navigate(AI_SETTINGS_PATH); onClose?.(); }} data-testid="expression-photo-manage">{formatMessage("expressions.photo.noModelManage")}</Button>
        : <p className="break-keep text-meta text-ink-muted" data-testid="expression-photo-ask">{formatMessage("expressions.photo.noModelAsk")}</p>}
      <Button type="button" variant="secondary" onClick={onImport} data-testid="expression-photo-import">{formatMessage("expressions.photo.noModelImport")}</Button>
    </>} />;
  }
  const provider = model.provider;
  const providerName = formatMessage(provider === PHOTO_PROVIDERS[0] ? "expressions.photo.providerOpenai" : "expressions.photo.providerGemini");

  async function submit(event: FormEvent) {
    event.preventDefault();
    // 이 양식은 컴포저 폼의 React 자손일 수 있다(포털 이벤트는 React 트리로 오른다).
    event.stopPropagation();
    if (!store || lock.current || busy || offline) return;
    // 닫는 것은 맨 처음이다: 이름 검사가 기다리는 사이에 다시 눌러도 요청은 한 번이다(모델 호출은 돈이다).
    lock.current = true;
    try {
      const problems: Invalid = {};
      const metadata: ExpressionMetadata = { name, displayName, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), subjectMemberId: face === Face.self ? store.memberId : null };
      if (file === null) problems.photo = formatMessage("expressions.photo.photoMissing");
      else if (!validExpressionFile(file)) problems.photo = formatMessage(EXPRESSION_FILE_ACCEPT.split(",").includes(file.type) ? "expressions.photo.photoSize" : "expressions.photo.photoType");
      if (face === Face.other) problems.face = formatMessage("expressions.photo.faceOtherBlocked");
      if (!isPhotoMetadata(metadata)) problems.fields = formatMessage("expressions.photo.fieldsInvalid");
      if (!consent) problems.consent = formatMessage("expressions.photo.consentMissing");
      if (Object.keys(problems).length === 0) {
        // 표준 이모지 이름과 겹치면 서버가 거절하니, 모델을 부르기 전에 먼저 알려 준다.
        const standard = await loadCatalog();
        if (standard.some((entry) => entry.shortcodes.includes(name))) problems.fields = formatMessage("expressions.photo.errorName");
      }
      if (alive.current) setInvalid(problems);
      if (Object.keys(problems).length > 0 || file === null) return;
      if (alive.current) setPhase({ kind: Step.busy });
      try {
        const result = await store.photoDraft(photoDraftRequest(store.base, buildPhotoMetadata({ branch, provider, metadata }), file));
        if (alive.current) setPhase({ kind: Step.made, result });
      } catch (error) {
        if (alive.current) setPhase({ kind: Step.failed, failure: failureOf(error) });
      }
    } finally {
      lock.current = false;
    }
  }

  return <form className="flex min-h-0 max-h-pane-lg flex-col gap-3" aria-label={formatMessage("expressions.photo.branchLabel")} noValidate data-testid="expression-photo-form" data-step={phase.kind} onSubmit={(event) => void submit(event)}>
    <p className="break-keep text-meta text-ink-muted">{formatMessage("expressions.photo.introText")}</p>
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.photo} className="text-meta font-semibold">{formatMessage("expressions.photo.photoLabel")}</label>
        <Input id={ids.photo} type="file" accept={EXPRESSION_FILE_ACCEPT} disabled={busy} onChange={(event) => { setFile(event.target.files?.item(0) ?? null); setInvalid((current) => ({ ...current, photo: undefined })); }} aria-invalid={invalid.photo ? true : undefined} data-testid="expression-photo-file" />
        {preview !== null && <img src={preview} alt={formatMessage("expressions.photo.photoPreviewAlt")} className="size-tray-thumb rounded-md bg-surface-hover object-contain" data-testid="expression-photo-preview" />}
        <p className="break-keep text-meta text-ink-muted">{formatMessage("expressions.photo.photoHint")}</p>
        {invalid.photo && <p role="alert" className="break-keep text-meta text-danger" data-testid="expression-photo-error-photo">{invalid.photo}</p>}
      </div>
      <div className="flex flex-col gap-1">
        <SegmentedControl legend={formatMessage("expressions.photo.branchLabel")} value={branch} onValueChange={setBranch} disabled={busy} testId="expression-photo-branch" options={[
          { value: cutout, label: formatMessage("expressions.photo.cutoutLabel") },
          { value: caricature, label: formatMessage("expressions.photo.caricatureLabel") },
        ]} />
        <p className="break-keep text-meta text-ink-muted" data-testid="expression-photo-branch-hint">{formatMessage(branch === cutout ? "expressions.photo.cutoutHint" : "expressions.photo.caricatureHint")}</p>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={ids.name} className="text-meta">{formatMessage("expressions.photo.nameLabel")}</label>
        <Input id={ids.name} value={name} maxLength={30} disabled={busy} onChange={(event) => setName(event.target.value)} placeholder={formatMessage("expressions.photo.namePlaceholder")} data-testid="expression-photo-name" />
        <label htmlFor={ids.display} className="text-meta">{formatMessage("expressions.photo.displayNameLabel")}</label>
        <Input id={ids.display} value={displayName} maxLength={40} disabled={busy} onChange={(event) => setDisplayName(event.target.value)} placeholder={formatMessage("expressions.photo.displayNamePlaceholder")} data-testid="expression-photo-display-name" />
        <label htmlFor={ids.tags} className="text-meta">{formatMessage("expressions.photo.tagsLabel")}</label>
        <Input id={ids.tags} value={tags} disabled={busy} onChange={(event) => setTags(event.target.value)} placeholder={formatMessage("expressions.photo.tagsPlaceholder")} data-testid="expression-photo-tags" />
        {invalid.fields && <p role="alert" className="break-keep text-meta text-danger" data-testid="expression-photo-error-fields">{invalid.fields}</p>}
        <label htmlFor={ids.face} className="text-meta">{formatMessage("expressions.photo.faceLabel")}</label>
        <Select id={ids.face} value={face} disabled={busy} onChange={(event) => setFace(Number(event.target.value))} data-testid="expression-photo-face">
          <option value={Face.none}>{formatMessage("expressions.photo.faceNone")}</option>
          <option value={Face.self}>{formatMessage("expressions.photo.faceSelf")}</option>
          <option value={Face.other}>{formatMessage("expressions.photo.faceOther")}</option>
        </Select>
        {invalid.face && <p role="alert" className="break-keep text-meta text-danger" data-testid="expression-photo-error-face">{invalid.face}</p>}
        <p className="break-keep text-meta text-ink-muted">{formatMessage("expressions.photo.fixedNote")}</p>
      </div>
    </div>
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <label className="flex items-start gap-2 rounded-md p-2 text-meta hover:bg-surface-hover active:bg-surface-pressed has-[:disabled]:hover:bg-transparent has-[:focus-visible]:focus-ring" data-testid="expression-photo-consent-row">
        <input type="checkbox" className="mt-1 size-4 shrink-0 accent-accent press focus-visible:focus-ring" checked={consent} disabled={busy} onChange={(event) => { setConsent(event.target.checked); setInvalid((current) => ({ ...current, consent: undefined })); }} data-testid="expression-photo-consent" />
        <span className="break-keep" data-provider={provider}>{formatMessage("expressions.photo.consent", { provider: providerName })}</span>
      </label>
      {invalid.consent && <p role="alert" className="break-keep text-meta text-danger" data-testid="expression-photo-error-consent">{invalid.consent}</p>}
      {offline && <p role="status" className="break-keep text-meta text-ink-muted">{formatMessage("expressions.photo.errorOffline")}</p>}
      {busy && <p role="status" className="break-keep text-meta text-ink-muted" data-testid="expression-photo-busy">{formatMessage("expressions.photo.busy")}</p>}
      {phase.kind === Step.failed && <p role="alert" className="break-keep text-meta text-danger" data-testid="expression-photo-failure" data-failure={phase.failure}>{formatMessage(FAILURE_KEY[phase.failure])}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onAgent} disabled={busy} data-testid="expression-photo-agent">{formatMessage("expressions.photo.agentInstead")}</Button>
        <Button type="submit" aria-disabled={busy ? true : undefined} disabled={offline || busy} data-testid="expression-photo-submit">{formatMessage("expressions.photo.submit")}</Button>
      </div>
    </div>
  </form>;
}
