import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { fetchRoster, type Channel, type RosterMember } from "@momo/core/lib/api";
import { rosterPaused } from "@momo/core/features/agents/agentOps";
import { upsertChannel } from "@momo/core/features/directory/model";
import {
  MAKE_DEFAULT_SIZE,
  MAKE_NOTE_MAX,
  MAKE_PRESET_MAX,
  MOTION_PRESETS,
  STILL_MOTION,
  buildMakeRequest,
  checkMakeSelection,
  fitsStillInput,
  makeNoteLength,
  toggleMotionChoice,
  type MakeIssue,
  type MotionChoice,
  type MotionPick,
} from "@momo/core/features/expressions/make";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { Select } from "@/design/ui/select";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import type { UploadHandle } from "@/features/attachments/uploadTransport";
import { EXPRESSION_FILE_ACCEPT, validExpressionFile } from "./media";
import { useExpressions } from "./context";
import { ExpressionMakePreview } from "./ExpressionMakePreview";
import { MakeStepError, makeFailureLine, resumeAttempt, runMakeAttempt, type MakeAttempt, type MakeStep } from "./makeFlow";
import { useReduceMotion } from "./useReduceMotion";

// =============================================================================
// 「AI와 만들기」 양식 (#4820 B, ADR-0218 §7 G8의 B 줄).
//
// 사람이 원본 사진, 움직임, 만들 에이전트, 메모를 고르면 그 에이전트와의 DM에 사진을
// 첨부한 요청 한 통이 나간다. 만드는 일은 에이전트가, 움직임을 입히는 일은 서버 조립이
// 하고, 결과는 그 DM에 승인 카드로 온다(카드 화면은 이 양식 밖이다). 이 양식의 책임은
// 「검사하고, 보내고, 그 대화로 데려다 준다」까지다.
//
// 문구는 다른 표현 기능처럼 컴포넌트 안에 둔다(다국어 사전은 i18n P1이 뽑는다).
// =============================================================================

type PhotoIssue = "empty" | "type" | "size" | "dimensions" | "unreadable";

const PHOTO_LINES: Record<PhotoIssue | "missing", string> = {
  missing: "원본 사진을 골라 주세요.",
  empty: "비어 있는 파일이에요. 다른 사진을 골라 주세요.",
  type: "PNG, JPG, WebP 또는 GIF 사진을 골라 주세요.",
  size: "사진이 너무 커요. 5MB 이하로 골라 주세요.",
  dimensions: "사진의 가로세로가 너무 커요. 4096픽셀 이하, 1600만 화소 이하로 줄여 주세요.",
  unreadable: "이 사진을 열 수 없어요. 다른 사진을 골라 주세요.",
};

const MAKE_ISSUE_LINES: Record<MakeIssue, string> = {
  motion_missing: "움직임을 하나 이상 고르거나 「움직임 없이」를 골라 주세요.",
  presets_unknown: "알 수 없는 움직임이에요. 다시 골라 주세요.",
  presets_duplicate: "같은 움직임을 두 번 고를 수 없어요.",
  presets_too_many: `움직임은 최대 ${MAKE_PRESET_MAX}개까지 고를 수 있어요.`,
  still_mixed: "「움직임 없이」는 다른 움직임과 함께 고를 수 없어요. 먼저 고른 쪽을 해제해 주세요.",
  note_too_long: `요청 메모는 ${MAKE_NOTE_MAX}자까지 쓸 수 있어요.`,
  size_invalid: "크기를 확인해 주세요.",
};

const STEP_LINES: Record<MakeStep, string> = {
  dm: "에이전트와 대화 여는 중",
  upload: "사진 올리는 중",
  send: "요청 보내는 중",
};

const PAUSED_SUFFIX = " (잠들어 있어요)";
const PREVIEW_EDGE = 192;

type RosterState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; agents: RosterMember[] };
type Phase = { kind: "idle" } | { kind: "busy"; step: MakeStep } | { kind: "failed"; line: string } | { kind: "sent"; channel: Channel };
interface Invalid { photo?: string; motion?: string; agent?: string; note?: string }

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("preview"));
    reader.onerror = () => reject(new Error("preview"));
    reader.readAsDataURL(file);
  });
}

/**
 * 칩 미리보기용 `data:` 그림과 원본의 가로세로. 배포 CSP 가 `blob:` 이미지를 막으므로 `data:` 다.
 * 디코드할 수 있으면 작게 줄여 다섯 칸이 큰 비트맵을 따로 들지 않게 하고, 디코드 도구가 없으면
 * 원본을 그대로 쓴다(그때 가로세로는 모른다).
 */
async function readPreview(file: File): Promise<{ src: string; width: number | null; height: number | null }> {
  if (typeof createImageBitmap !== "function") return { src: await fileDataUrl(file), width: null, height: null };
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, PREVIEW_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (context === null) return { src: await fileDataUrl(file), width: bitmap.width, height: bitmap.height };
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { src: canvas.toDataURL("image/png"), width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function photoIssueOf(file: File): PhotoIssue | null {
  if (validExpressionFile(file)) return null;
  if (!EXPRESSION_FILE_ACCEPT.split(",").includes(file.type)) return "type";
  return file.size === 0 ? "empty" : "size";
}

/** 성공한 뒤에만 서는 자리: 새 DM을 목록에 넣고 그 대화로 가고 고르개를 닫는다. useOpenDm 과 같은 길이다. */
function LandOnDm({ workspaceId, channel, onLanded }: { workspaceId: string; channel: Channel; onLanded?: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    client.setQueryData<Channel[]>(["channels", workspaceId], (current) => current ? upsertChannel(current, channel) : [channel]);
    void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
    navigate(`/c/${channel.id}`);
    onLanded?.();
  }, [client, navigate, workspaceId, channel, onLanded]);
  return null;
}

export function ExpressionMakeForm({ onImport, onClose }: { onImport: () => void; onClose?: () => void }) {
  const { store, offline } = useExpressions();
  const reduce = useReduceMotion();
  const uid = useId();
  const ids = { photo: `${uid}-photo`, photoLine: `${uid}-photo-line`, motion: `${uid}-motion`, agent: `${uid}-agent`, note: `${uid}-note`, offline: `${uid}-offline` };
  const [file, setFile] = useState<File | null>(null);
  const [photoIssue, setPhotoIssue] = useState<PhotoIssue | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [photoVersion, setPhotoVersion] = useState(0);
  const [replays, setReplays] = useState<Record<string, number>>({});
  const [pick, setPick] = useState<MotionPick>({ presets: [], still: false });
  const [motionLine, setMotionLine] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  const [note, setNote] = useState("");
  const [roster, setRoster] = useState<RosterState>({ kind: "loading" });
  const [rosterTry, setRosterTry] = useState(0);
  const [invalid, setInvalid] = useState<Invalid>({});
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const lock = useRef(false);
  const alive = useRef(true);
  const attempt = useRef<MakeAttempt | null>(null);
  const upload = useRef<UploadHandle | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const firstChipRef = useRef<HTMLButtonElement>(null);
  const agentRef = useRef<HTMLSelectElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const busy = phase.kind === "busy";
  const sent = phase.kind === "sent";
  const locked = busy || sent;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; upload.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!store) return;
    let live = true;
    setRoster({ kind: "loading" });
    void fetchRoster(store.workspaceId).then((members) => {
      if (!live) return;
      const agents = members.filter((member) => member.kind === "agent" && member.status === "active");
      setRoster({ kind: "ready", agents });
      // 하나뿐이면 미리 골라 둔다. 여럿이면 사람이 고른다.
      setAgentId((current) => agents.some((agent) => agent.id === current) ? current : agents.length === 1 ? agents[0].id : "");
    }, () => { if (live) setRoster({ kind: "error" }); });
    return () => { live = false; };
  }, [store, rosterTry]);

  useEffect(() => {
    if (file === null) { setPreview(null); return; }
    let live = true;
    readPreview(file).then(({ src, width, height }) => {
      if (!live) return;
      if (width !== null && height !== null && !fitsStillInput(width, height)) { setPhotoIssue("dimensions"); setPreview(null); return; }
      setPreview(src);
      setPhotoVersion((value) => value + 1);
    }, () => { if (live) { setPhotoIssue("unreadable"); setPreview(null); } });
    return () => { live = false; };
  }, [file]);

  if (!store) return null;
  const agents = roster.kind === "ready" ? roster.agents : [];
  // 불러오는 중이거나 불러오지 못했거나 비어 있으면 고를 에이전트가 없다. 보내기는 그 셋 모두에서 잠긴다.
  const noAgents = agents.length === 0;
  const noteCount = makeNoteLength(note);
  const clear = (key: keyof Invalid) => setInvalid((current) => current[key] === undefined ? current : { ...current, [key]: undefined });

  function onPhoto(target: HTMLInputElement) {
    const picked = target.files?.item(0) ?? null;
    setPhotoIssue(null); setPreview(null); clear("photo");
    if (picked === null) { setFile(null); return; }
    const issue = photoIssueOf(picked);
    if (issue !== null) { target.value = ""; setFile(null); setPhotoIssue(issue); return; }
    setFile(picked);
  }

  function press(choice: MotionChoice) {
    // 누르면 그 칸의 미리보기가 다시 재생된다(고르든 막히든).
    setReplays((current) => ({ ...current, [choice]: (current[choice] ?? 0) + 1 }));
    const result = toggleMotionChoice(pick, choice);
    if (!result.ok) { setMotionLine(MAKE_ISSUE_LINES[result.issue]); return; }
    setPick(result.pick); setMotionLine(null); clear("motion");
  }

  /** 막힌 곳이 있으면 줄을 띄우고 첫 칸으로 초점을 옮긴다. */
  function validate(): boolean {
    const problems: Invalid = {};
    if (file === null) problems.photo = photoIssue !== null ? PHOTO_LINES[photoIssue] : PHOTO_LINES.missing;
    else if (photoIssue !== null) problems.photo = PHOTO_LINES[photoIssue];
    const check = checkMakeSelection({ presets: pick.presets, still: pick.still, note, size: MAKE_DEFAULT_SIZE });
    if (!check.ok) {
      const issues = check.issues.filter((issue) => issue !== "note_too_long");
      if (issues.length > 0) problems.motion = MAKE_ISSUE_LINES[issues[0]];
      if (check.issues.includes("note_too_long")) problems.note = MAKE_ISSUE_LINES.note_too_long;
    }
    if (!agents.some((agent) => agent.id === agentId)) problems.agent = "만들 에이전트를 골라 주세요.";
    setInvalid(problems);
    if (problems.photo) photoRef.current?.focus();
    else if (problems.motion) firstChipRef.current?.focus();
    else if (problems.agent) agentRef.current?.focus();
    else if (problems.note) noteRef.current?.focus();
    return Object.keys(problems).length === 0;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    // 이 양식은 컴포저 폼의 React 자손일 수 있다(포털 이벤트는 React 트리로 오른다).
    event.stopPropagation();
    if (!store || lock.current || locked || offline) return;
    if (!validate() || file === null) return;
    lock.current = true;
    const body = buildMakeRequest({ presets: pick.presets, still: pick.still, note, size: MAKE_DEFAULT_SIZE });
    const current = resumeAttempt(attempt.current, { agentId, file, body });
    attempt.current = current;
    setPhase({ kind: "busy", step: current.channel === undefined ? "dm" : current.attachmentId === undefined ? "upload" : "send" });
    try {
      const outcome = await runMakeAttempt(store.workspaceId, current, {
        step: (step) => { if (alive.current) setPhase({ kind: "busy", step }); },
        uploading: (handle) => { upload.current = handle; },
        cancelled: () => !alive.current,
      });
      if (outcome === "cancelled" || !alive.current) return;
      setPhase({ kind: "sent", channel: outcome.channel });
    } catch (error) {
      if (!alive.current) return;
      const step = error instanceof MakeStepError ? error.step : "send";
      setPhase({ kind: "failed", line: makeFailureLine(step, error instanceof MakeStepError ? error.cause : error) });
    } finally {
      lock.current = false;
    }
  }

  const chips: { id: MotionChoice; label: string; description: string }[] = [
    ...MOTION_PRESETS.map((entry) => ({ id: entry.id as MotionChoice, label: entry.label, description: entry.description })),
    { id: STILL_MOTION.id, label: STILL_MOTION.label, description: STILL_MOTION.description },
  ];
  const invalidMotion = invalid.motion ?? null;
  // 목록을 못 받았거나 에이전트가 없으면 이 양식으로 보낼 수 없다: 양식 대신 그 사실 한 줄과 행동 하나를 보인다.
  // 사람이 고른 것은 이 컴포넌트가 들고 있으므로 다시 시도로 목록이 돌아오면 그대로 이어진다.
  const gated = roster.kind === "error" || (roster.kind === "ready" && noAgents);

  return <form className="flex min-h-0 max-h-pane-lg flex-col gap-3" aria-label="AI와 만들기" noValidate data-testid="expression-make-form" data-state={phase.kind} onSubmit={(event) => void submit(event)}>
    <p className="break-keep text-meta text-ink-muted">고른 사진으로 에이전트가 팀 이모티콘을 만들고, 결과는 대화에 승인 카드로 와요.</p>
    {roster.kind === "error" && <InlineBanner message="에이전트 목록을 불러오지 못했어요. 다시 시도해 주세요." actionLabel="다시 시도" onAction={() => setRosterTry((value) => value + 1)} separator={false} className="px-0" testId="expression-make-roster-error" />}
    {roster.kind === "ready" && noAgents && <EmptyInvite headline="아직 에이전트가 없어요" detail="AI와 만들려면 에이전트가 있어야 해요. 지금은 사진이나 링크로 가져올 수 있어요." className="px-0 py-3" testId="expression-make-empty" actions={<Button type="button" variant="secondary" onClick={onImport}>가져오기</Button>} />}
    {/* 고르는 칸은 스크롤되고, 보내기와 그 결과 줄은 아래에 붙어 있어서 어디까지 내려가 있어도 보인다.
        막혀 있을 때는 지우지 않고 숨긴다: 고른 사진이 칸 안의 상태로 남아 다시 시도 뒤에도 어긋나지 않는다. */}
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" hidden={gated} data-testid="expression-make-body">
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.photo} className="text-meta font-semibold">원본 사진</label>
        <Input ref={photoRef} id={ids.photo} type="file" accept={EXPRESSION_FILE_ACCEPT} disabled={locked} onChange={(event) => onPhoto(event.target)} aria-invalid={invalid.photo || photoIssue ? true : undefined} aria-describedby={ids.photoLine} data-testid="expression-make-photo" />
        {file !== null && preview !== null && photoIssue === null && <div className="flex items-center gap-2" data-testid="expression-make-photo-preview">
          <img src={preview} alt="고른 원본 사진 미리보기" className="size-tray-thumb shrink-0 rounded-md bg-surface-hover object-contain" />
          <p className="min-w-0 break-all text-meta text-ink-muted">{file.name}<span className="block" data-numeric>{(file.size / 1024).toFixed(file.size < 10240 ? 1 : 0)} KiB</span></p>
        </div>}
        <p id={ids.photoLine} role="alert" className="break-keep text-meta text-danger" data-testid="expression-make-photo-error">{invalid.photo ?? (photoIssue !== null ? PHOTO_LINES[photoIssue] : "")}</p>
        <p className="break-keep text-meta text-ink-muted">5MB 이하의 움직이지 않는 PNG, JPG, WebP, GIF를 쓸 수 있어요.</p>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" aria-describedby={ids.motion}>
        <legend className="p-0 text-meta font-semibold">움직임</legend>
        <div className="grid grid-cols-2 gap-2">
          {chips.map((chip, index) => {
            const selected = chip.id === STILL_MOTION.id ? pick.still : pick.presets.includes(chip.id);
            return <button key={chip.id} ref={index === 0 ? firstChipRef : undefined} type="button" aria-pressed={selected} disabled={locked} onClick={() => press(chip.id)} data-testid={`expression-make-chip-${chip.id}`}
              className={cn("tap-target flex min-w-0 items-center gap-2 rounded-lg border border-line p-2 text-left press focus-visible:focus-ring disabled:opacity-50", selected ? "bg-surface-muted" : "hover:bg-surface-hover", chip.id === STILL_MOTION.id && "col-span-2")}>
              <ExpressionMakePreview motion={chip.id} src={preview} playKey={`${photoVersion}:${replays[chip.id] ?? 0}`} reduce={reduce} testId={`expression-make-preview-${chip.id}`} />
              <span className="flex min-w-0 flex-1 flex-col break-keep"><span className="text-body font-semibold">{chip.label}</span><span className="text-meta text-ink-muted">{chip.description}</span></span>
              {selected && <Check aria-hidden="true" className="size-4 shrink-0" />}
            </button>;
          })}
        </div>
        <p className="break-keep text-meta text-ink-muted">최대 {MAKE_PRESET_MAX}개까지 고를 수 있어요. 미리보기는 비슷한 움직임이고, 실제 결과는 승인 카드에서 확인해요.</p>
        <p id={ids.motion} role="status" className="break-keep text-meta text-danger" data-testid="expression-make-motion-status">{motionLine ?? invalidMotion ?? ""}</p>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label htmlFor={ids.agent} className="text-meta font-semibold">만들 에이전트</label>
        {roster.kind === "loading" && <Skeleton ready={false} rows={1} />}
        {roster.kind === "ready" && <>
          <Select ref={agentRef} id={ids.agent} value={agentId} disabled={locked} onChange={(event) => { setAgentId(event.target.value); clear("agent"); }} aria-invalid={invalid.agent ? true : undefined} data-testid="expression-make-agent">
            <option value="">에이전트를 골라 주세요</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}{rosterPaused(agent) === true ? PAUSED_SUFFIX : ""}</option>)}
          </Select>
          <p className="break-keep text-meta text-ink-muted">그림 만들기 도구가 없는 에이전트는 만들 수 없다고 답해요.</p>
        </>}
        {invalid.agent && <p role="alert" className="text-meta text-danger">{invalid.agent}</p>}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={ids.note} className="text-meta font-semibold">요청 메모 (선택)</label>
        <textarea ref={noteRef} id={ids.note} rows={3} value={note} disabled={locked} placeholder="예: 웃는 얼굴로 만들어 주세요" onChange={(event) => { setNote(event.target.value); clear("note"); }} aria-invalid={invalid.note ? true : undefined}
          className="w-full resize-y rounded-lg border border-line-strong bg-transparent px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50" data-testid="expression-make-note" />
        <p className={cn("font-mono text-meta", noteCount > MAKE_NOTE_MAX ? "text-danger" : "text-ink-muted")} data-numeric data-testid="expression-make-note-count">{noteCount}/{MAKE_NOTE_MAX}</p>
        {invalid.note && <p role="alert" className="text-meta text-danger">{invalid.note}</p>}
      </div>
    </div>

    <div className="flex flex-col gap-2 border-t border-line pt-3" hidden={gated} data-testid="expression-make-footer">
      {offline && <p id={ids.offline} role="status" className="break-keep text-meta text-ink-muted">연결이 끊겼어요. 연결되면 요청을 보낼 수 있어요.</p>}
      {busy && <p role="status" className="text-meta text-ink-muted" data-testid="expression-make-status">{STEP_LINES[phase.step]}</p>}
      {phase.kind === "failed" && <p role="alert" className="break-keep text-meta text-danger" data-testid="expression-make-error">{phase.line}</p>}
      {sent && <p role="status" className="break-keep text-meta" data-testid="expression-make-sent">요청을 보냈어요. 에이전트의 답과 승인 카드는 대화에서 볼 수 있어요.</p>}
      <Button type="submit" className="self-end" aria-disabled={busy ? true : undefined} aria-describedby={offline ? ids.offline : undefined} disabled={offline || noAgents || sent} data-testid="expression-make-submit">{busy ? "요청 보내는 중" : phase.kind === "failed" ? "다시 시도" : "요청 보내기"}</Button>
    </div>
    {phase.kind === "sent" && <LandOnDm workspaceId={store.workspaceId} channel={phase.channel} onLanded={onClose} />}
  </form>;
}
