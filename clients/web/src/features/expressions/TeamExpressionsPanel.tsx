import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { fetchRoster } from "@momo/core/lib/api";
import type { MessageKey } from "@momo/core/i18n";
import { isExpressionFavorite } from "@momo/core/features/expressions/favorites";
import { buildExpressionSections, EXPRESSION_GRID_ENTRY_SELECTOR, isGridEntryKey } from "@momo/core/features/expressions/gridSections";
import { matchesExpressionContract } from "@momo/core/features/expressions/contracts";
import { expressionToken } from "@momo/core/features/expressions/message";
import { firstFilledView, type ExpressionView } from "@momo/core/features/expressions/kind";
import type { Expression, ExpressionDraft, ExpressionMetadata } from "@momo/core/features/expressions/types";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { Select } from "@/design/ui/select";
import { SegmentedControl } from "@/design/ui/segmented-control";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/design/ui/dropdown-menu";
import { ContextMenuItem } from "@/design/ui/context-menu";
import { Tooltip } from "@/design/ui/tooltip";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { LoadFailureNote } from "@/features/common/LoadFailureBox";
import { loadCauseOf } from "@/features/common/loadFailure";
import { CONNECTION_KEYS } from "@momo/core/features/connection/copyKeys";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { loadCatalog } from "@/features/emoji/catalog";
import { ExpressionDraftCard } from "./ExpressionDraftCard";
import { ExpressionMakeEntry } from "./ExpressionMakeEntry";
import { EXPRESSION_FILE_ACCEPT, validExpressionFile } from "./media";
import { ExpressionGrid } from "./ExpressionGrid";
import { useExpressions } from "./context";
import { BlockedReason } from "@/features/common/BlockedReason";

// 「＋」는 메뉴다: 가져오기(직접 올리기·출처 링크)와 AI와 만들기. 두 길은 권한(canAdd)과 오프라인 규칙이 같다.
type PanelMode = "list" | "import" | "make";
// 잠금의 흐림은 잠금과 한 식이 켠다(#1486 문법). 클래스 글자는 상수로 둬서 JSX 식 안의 문자열로 세지 않는다.
const DIM = "opacity-50";
// 머리 줄의 정렬도 상수다(같은 이유): 호스트가 보기를 정해 주면 「우리 팀」 머리글이 없어 「목록으로」(양식이 열린 동안)만 오른쪽 끝에 선다. 「추가하기」는 이 줄이 아니라 세트 띠 끝의 ＋다.
const HEADER_ROW = "flex flex-wrap items-center gap-2";
const HEADER_END = "justify-end";
const HEADER_SPLIT = "justify-between";

// 두 보기의 이름은 사전의 것이다: 폰 시트의 탭 이름(owner 10-31, #4942 → 11-05 #5330)과 같은 체계다(이모티콘 · GIF). 값이 곧 코어의 보기 이름이다.
// 사용자에게 보이는 이름은 「이모티콘」 하나라서 앞 판의 「팀 이모지」 보기는 「이모티콘」 보기에 합쳤다(작은 것과 큰 것이 한 보기, 코어 `expressionsForView`).
const VIEW_OPTIONS = [
  { value: "emoticon", name: "expressions.panel.viewEmoticon" },
  { value: "gif", name: "expressions.panel.viewGif" },
] as const satisfies readonly { value: ExpressionView; name: MessageKey }[];

export function TeamExpressionsPanel({ onPick, onPickExpression, purpose, onClose, escapeClaim, view: fixedView }: { onPick: (token: string) => void;
  /**
   * 입력창 위 미리 보기로 고르는 호스트(메인 컴포저, #5453)가 준다. 주면 고른 표현을 `:이름:` 글로 넣지 않고 표현 자체를 넘긴다 - 호스트가 입력창 위에 미리
   * 보여 주고 보내기 한 번에 글과 함께 보낸다. 주지 않으면 예전 그대로 `onPick(토큰)`이다(스레드 입력칸·반응).
   */
  onPickExpression?: (expression: Expression) => void; purpose: "reaction" | "insert"; /** 요청을 보낸 뒤 고르개를 닫는다. 없으면 열어 둔 채로 둔다. */ onClose?: () => void;
  /**
   * 호스트(고르개)가 탭으로 보기를 정해 준다. 주면 이 패널은 자기 보기 고르기와 「우리 팀」 머리글을 그리지 않는다 — 탭 줄이 그 일을 한다(owner 11-05).
   * 주지 않으면(단독으로 쓸 때) 이모티콘·GIF 고르기를 스스로 그리고, 사람이 고르기 전에는 등록이 있는 첫 보기를 연다.
   */
  view?: ExpressionView;
  /**
   * 확인 단계가 서 있는 동안 Esc의 임자가 되는 자리. 고르개(Radix 팝오버)가 Esc를 문서 캡처 단계에서 먼저 가져가므로, 고르개가
   * 이 ref를 읽어 확인 단계 취소를 부른다. 확인이 없으면 null이다. 확인 단계에서 Esc가 고르개 통째로 닫으면 안 된다(#4986).
   */
  escapeClaim?: MutableRefObject<(() => void) | null> }) {
  const { store, cache, usage, favorites, status, offline, failure } = useExpressions();
  const formatMessage = useFormatMessage();
  const [query, setQuery] = useState("");
  // 창을 여는 순간의 사용 기록과 시각을 한 번 쥔다(#5503): 이모티콘 탭 맨 위 「자주·최근」 칸의 차례는 열려 있는 동안 보내기가 성공해 기록이 바뀌어도 흔들리지 않고,
  // 고르개를 다시 열 때(이 패널이 새로 설 때)만 새로 계산한다. 그림 목록(`cache.items`)은 계속 실시간이라 지워지거나 숨겨진 그림은 바로 빠진다.
  const [opened] = useState(() => ({ usage, nowMs: Date.now() }));
  // ADR-0218 §10 J2 + 2026-11-05 증보: 두 보기가 보관함을 겹치지 않게 나눈다(코어 `expressionsForView`). 이모티콘 = 작은 이모티콘(움직여도)과
  // 움직이지 않는 큰 그림, GIF = 움직이는 큰 그림. 한 등록은 정확히 한 보기에 있다. 보기의 값이 곧 코어의 보기 이름이다.
  // 호스트가 보기를 주지 않았고 사람도 고르기 전이면 등록이 있는 첫 보기를 연다(움직이는 큰 그림뿐인 팀이 빈 이모티콘 보기를 먼저 보지 않게).
  const [picked, setPicked] = useState<ExpressionView | null>(null);
  const view = fixedView ?? picked ?? firstFilledView(cache.items);
  const [mode, setMode] = useState<PanelMode>("list");
  const addTrigger = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const focusTrigger = useRef(false);
  const [admin, setAdmin] = useState(false);
  const [target, setTarget] = useState<{ item: Expression; action: "delete" | "report" } | null>(null);
  // 확인 단계는 이 고르개 안의 단계다. 별도 대화상자(스크림 층 200)가 고르개(표면 층 300) 아래에 깔려서 고르개가 밝게 남았다(#4986).
  // 닫으면 초점이 그 항목의 「관리」로 돌아간다. 목록은 확인 중에 내려가므로 단추 노드를 들고 있지 않고 항목 id로 다시 찾는다.
  const returnFocusTo = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 신고·삭제를 고르면 격자가 내려가고 확인 단계가 선다. 그때 메뉴가 닫히며 초점을 되돌리려 하면 단계의 「취소」 대신 고르개 바탕으로 가므로 막는다(초점은 아래 효과가 정한다).
  const confirmOpened = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmTitleId = useId();
  const confirmBodyId = useId();
  const [reason, setReason] = useState("copyright");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const canAdd = cache.addPolicy === "members" || admin;
  useEffect(() => {
    if (!store) return;
    let live = true;
    void fetchRoster(store.workspaceId).then((members) => {
      if (live) setAdmin(members.some((member) => member.id === store.memberId && (member.role === "admin" || member.role === "owner")));
    }, () => {});
    return () => { live = false; };
  }, [store]);
  // 메뉴가 닫히며 트리거가 사라지므로(양식 모드에서는 「목록으로」가 그 자리다) 초점을 직접 옮긴다.
  // 양식이 열리면 「목록으로」, 목록으로 돌아오면 「추가하기」다.
  useLayoutEffect(() => {
    if (mode !== "list") backButton.current?.focus();
    else if (focusTrigger.current) { focusTrigger.current = false; addTrigger.current?.focus(); }
  }, [mode]);
  // 확인 단계가 서면 초점은 「취소」로 간다(되돌릴 수 없는 쪽이 아니라 안전한 쪽). 닫히면 그 항목의 「관리」로 돌아가고,
  // 항목이 사라졌으면(지움·신고로 숨김) 목록의 검색 칸으로 간다 — 초점이 문서 처음(body)으로 떨어지지 않게.
  useLayoutEffect(() => {
    if (target !== null) { cancelRef.current?.focus(); return; }
    const id = returnFocusTo.current;
    if (id === null) return;
    returnFocusTo.current = null;
    const manage = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-manage]") ?? [])].find((node) => node.getAttribute("data-manage") === id);
    (manage ?? searchRef.current)?.focus();
  }, [target]);
  function closeConfirm() {
    // 보내는 동안에는 닫지 않는다: 요청은 이미 나갔고, 결과를 이 단계가 말해야 한다.
    if (busy || lock.current || !target) return;
    returnFocusTo.current = target.item.id;
    setError(null);
    setTarget(null);
  }
  const closeConfirmRef = useRef(closeConfirm);
  closeConfirmRef.current = closeConfirm;
  const confirming = target !== null;
  useEffect(() => {
    if (!escapeClaim || !confirming) return;
    escapeClaim.current = () => closeConfirmRef.current();
    return () => { escapeClaim.current = null; };
  }, [escapeClaim, confirming]);
  if (!store) return null;
  function backToList() { focusTrigger.current = true; setMode("list"); }
  // 그림 격자의 구역(코어 `buildExpressionSections`): 최근 -> 즐겨찾기 -> 세트별 -> 기타, 검색어가 있으면 관련도 차례의 결과 하나. 보기 이름이 곧 탭 이름이다.
  // 이모티콘 보기의 「최근」 칸은 정지 그림과 GIF 를 섞은 「자주·최근」이다(열 때 쥔 `opened` 로 센다).
  const sections = buildExpressionSections(cache.items, view, { query, usage: opened.usage, favorites, nowMs: opened.nowMs });
  async function confirm() {
    if (!store || !target || lock.current || offline) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      await store.mutate({ method: target.action === "delete" ? "DELETE" : "POST", path: `${store.base}/expressions/${target.item.id}${target.action === "report" ? "/report" : ""}`, body: target.action === "report" ? { reason } : undefined });
      returnFocusTo.current = target.item.id;
      setTarget(null);
    } catch { setError("변경하지 못했어요. 연결과 권한을 확인하고 다시 시도해 주세요."); }
    finally { lock.current = false; setBusy(false); }
  }
  // 검색 칸에서 아래 화살표 = 격자로 들어간다(탭 순서에 있는 한 칸으로). 격자가 없으면(비었거나 불러오는 중) 아무 일도 없다.
  function enterGrid(event: KeyboardEvent<HTMLInputElement>) {
    if (!isGridEntryKey(event.key)) return;
    const cell = listRef.current?.querySelector<HTMLElement>(EXPRESSION_GRID_ENTRY_SELECTOR);
    if (!cell) return;
    event.preventDefault();
    cell.focus();
  }
  // 눌린 순간의 목록에서 다시 찾는다: 그 사이 숨겨졌거나 지워졌으면 고르지 않는다.
  function pick(item: Expression) {
    const active = store!.getSnapshot().cache.items.find((entry) => entry.id === item.id && entry.name === item.name);
    if (active?.status !== "active") return;
    if (onPickExpression) onPickExpression(active);
    else onPick(expressionToken(active.name));
  }
  // 칸의 항목 메뉴(오른쪽 클릭·길게 누르기): 즐겨찾기(이 기기에만 저장)와 예전 「관리」 메뉴의 신고·삭제.
  const keepConfirmFocus = (event: Event) => { if (confirmOpened.current) { confirmOpened.current = false; event.preventDefault(); } };
  const cellMenu = (item: Expression) => <>
    <ContextMenuItem onSelect={() => store!.toggleFavorite(item.id)}>{formatMessage(isExpressionFavorite(favorites, item.id) ? "expressions.picker.favoriteRemove" : "expressions.picker.favoriteAdd")}</ContextMenuItem>
    <ContextMenuItem onSelect={() => { confirmOpened.current = true; setError(null); setTarget({ item, action: "report" }); }}>신고하기</ContextMenuItem>
    <ContextMenuItem disabled={item.createdBy !== store!.memberId && !admin} onSelect={() => { confirmOpened.current = true; setError(null); setTarget({ item, action: "delete" }); }}>삭제하기{item.createdBy !== store!.memberId && !admin ? " (만든 사람·관리자만)" : ""}</ContextMenuItem>
  </>;
  // 「추가하기」는 세트 띠 끝의 작은 ＋다. 같은 메뉴(가져오기 · AI와 만들기)를 열고 권한(canAdd)과 오프라인 규칙도 같다.
  const addMenu = <DropdownMenu><Tooltip label={formatMessage("expressions.picker.add")} side="top" align="end"><DropdownMenuTrigger asChild disabled={!canAdd || offline}><Button ref={addTrigger} type="button" variant="ghost" size="icon" aria-label={formatMessage("expressions.picker.add")} disabled={!canAdd || offline} data-testid="expression-add-menu"><Plus aria-hidden="true" /></Button></DropdownMenuTrigger></Tooltip><DropdownMenuContent align="end" side="top">
    <DropdownMenuItem data-testid="expression-add-import" onSelect={() => setMode("import")}>가져오기</DropdownMenuItem>
    <DropdownMenuItem data-testid="expression-add-make" onSelect={() => setMode("make")}>AI와 만들기</DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu>;
  const back = confirming || mode === "list" ? null : <Button ref={backButton} type="button" variant="secondary" size="sm" onClick={backToList}><ArrowLeft aria-hidden="true" />목록으로</Button>;
  return <div className="flex min-h-0 flex-col gap-3" data-testid="team-expressions">
    {fixedView && back === null ? null : <div className={cn(HEADER_ROW, fixedView ? HEADER_END : HEADER_SPLIT)}>{fixedView ? null : <p className="text-body font-semibold">우리 팀</p>}{back}</div>}
    {!canAdd && <p className="text-meta text-ink-muted">이 팀은 관리자만 새 그림을 올릴 수 있어요.</p>}
    {offline && <InlineBanner message={<BlockedReason frame="reloadPicturesLater" />} separator={false} />}
    {confirming ? <div role="group" aria-labelledby={confirmTitleId} aria-describedby={confirmBodyId} className="flex flex-col gap-3" data-testid="expression-confirm">
      <p id={confirmTitleId} className="text-title font-semibold text-ink">{target.action === "delete" ? "팀 그림을 삭제할까요?" : "팀 그림을 신고할까요?"}</p>
      <p id={confirmBodyId} className="text-body text-ink-muted">{target.action === "delete" ? "지운 이름은 다시 쓸 수 없어요. 예전 메시지와 반응은 이름 문자열로 표시돼요." : "신고하면 팀 전체에서 즉시 숨겨져요. 신고자와 내용은 관리자만 볼 수 있어요."}</p>
      {target.action === "report" && <label className="text-body">신고 사유<Select value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy}><option value="copyright">저작권</option><option value="face">사람 얼굴</option><option value="other">기타</option></Select></label>}
      {error && <p role="alert" className="text-body text-danger">{error}</p>}
      {/* 진행·잠금 문법(#1486): 보내는 단추는 `aria-busy` + 바뀐 낱말이고 자기 진행으로 잠그지도 흐리지도 않는다. 형제인 「취소」는
          그 진행 때문에 잠기므로 aria-disabled + 흐림 + 가드(closeConfirm)다. 둘 다 네이티브 disabled가 아니라서 초점을 쥔 단추가
          disabled가 되어 초점이 body로 떨어지는 일이 없다(#4986). 연결이 없을 때만 보내는 단추도 잠긴다. */}
      <div className="flex justify-end gap-2"><Button ref={cancelRef} type="button" variant="secondary" aria-disabled={busy || undefined} className={cn(busy && DIM)} onClick={closeConfirm}>취소</Button><Button type="button" variant="destructive" aria-busy={busy || undefined} aria-disabled={offline || undefined} className={cn(offline && DIM)} onClick={() => void confirm()}>{busy ? "처리 중" : target.action === "delete" ? "삭제하기" : "신고하고 숨기기"}</Button></div>
    </div> : mode === "import" ? <ExpressionUploadForm onDone={backToList} /> : mode === "make" ? <ExpressionMakeEntry onImport={() => setMode("import")} onDone={backToList} onClose={onClose} /> : <>
      {fixedView ? null : <SegmentedControl legend={formatMessage("expressions.panel.viewsLegend")} value={view} onValueChange={setPicked} options={VIEW_OPTIONS.map(({ value, name }) => ({ value, label: formatMessage(name) }))} />}
      <Input ref={searchRef} type="search" className="shrink-0" aria-label={formatMessage(view === "gif" ? "expressions.sheet.searchGif" : "expressions.sheet.searchEmoticon")} placeholder="이름, 태그, 초성으로 검색" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={enterGrid} />
      {/* 다시 읽기가 실패해도 이미 받아 둔 목록은 지우지 않는다(#5279 C, #5242 규칙): 한 줄이 위에서 원인과 함께 말하고 목록은 그대로 서 있다. 받아 둔 것이 없을 때만 한 줄뿐이다. */}
      {status === "error" && <LoadFailureNote titleKey={CONNECTION_KEYS.loadTeamExpressionsTitle} cause={loadCauseOf(failure)} onRetry={() => void store.refresh()} separator={false} testId="team-expressions-error" />}
      {/* 격자는 어느 상태에서도 서고(띠의 ＋가 늘 닿는다 - 예전 머리 줄의 「추가하기」처럼), 격자 자리는 상태가 정한다: 불러오는 중 = 스켈레톤, 받아 둔 것 없이 실패 = 위 한 줄뿐, 비어 있음 = 안내. */}
      <ExpressionGrid
          sections={sections}
          empty={status === "loading" ? <Skeleton ready={false} rows={4} /> : status === "error" && cache.items.length === 0 ? null : <EmptyInvite headline={query ? "맞는 팀 그림이 없어요" : cache.items.length > 0 ? formatMessage("expressions.panel.viewEmpty") : "아직 팀 그림이 없어요"} actions={<Button type="button" variant="secondary" disabled={!canAdd || offline} onClick={() => query ? setQuery("") : setMode("import")}>{query ? "검색 지우기" : "첫 그림 올리기"}</Button>} />}
          containerRef={listRef}
          disabled={offline}
          cellLabel={(item) => `${item.displayName} ${purpose === "reaction" ? "반응으로 고르기" : "메시지에 넣기"}`}
          onPick={pick}
          menu={cellMenu}
          onMenuCloseAutoFocus={keepConfirmFocus}
          trailing={addMenu}
        />
    </>}
  </div>;
}

function ExpressionUploadForm({ onDone }: { onDone: () => void }) {
  const { store, offline } = useExpressions();
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [tags, setTags] = useState("");
  const [face, setFace] = useState("none");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<ExpressionDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  if (!store) return null;
  async function prepare() {
    if (!store || busy || lock.current || offline) return;
    const metadata: ExpressionMetadata = { name, displayName, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), subjectMemberId: face === "self" ? store.memberId : null };
    if (face === "other") { setError("내 얼굴 한 명인 그림만 승인할 수 있어요. 다른 사람이나 여러 사람 얼굴은 올리지 말아 주세요."); return; }
    if (!matchesExpressionContract("Metadata", metadata)) { setError("이름은 영문 소문자·숫자·밑줄·하이픈 2~30자, 표시 이름은 40자, 태그는 8개 이하로 써 주세요."); return; }
    if (!url && (!file || !validExpressionFile(file))) { setError("5MB 이하의 PNG, JPG, WebP 또는 GIF를 골라 주세요."); return; }
    if (url && !matchesExpressionContract("ImportRequest", { ...metadata, url })) { setError("공개 HTTPS 출처 링크를 넣어 주세요."); return; }
    lock.current = true; setBusy(true); setError(null);
    try {
      const standard = await loadCatalog();
      if (standard.some((entry) => entry.shortcodes.includes(name))) { setError("기본 이모티콘과 겹치는 이름이에요. 다른 이름을 써 주세요."); return; }
      const value = await store.draft({ method: "POST", path: `${store.base}/expressions/${url ? "import" : "uploads"}`, body: url ? { ...metadata, url } : metadata, file: url ? undefined : file! });
      setDraft(value);
    } catch { setError("미리보기를 만들지 못했어요. 이름, 파일과 연결을 확인하고 다시 시도해 주세요."); }
    finally { lock.current = false; setBusy(false); }
  }
  if (draft) return <div className="min-h-0 max-h-pane-lg overflow-y-auto"><ExpressionDraftCard draft={draft} onReplace={setDraft} onApprove={async (choice) => { await store.mutate({ method: "POST", path: `${store.base}/expressions`, body: choice }); onDone(); }} /><Button type="button" variant="ghost" onClick={() => setDraft(null)}>다른 그림 고르기</Button></div>;
  return <form className="flex min-h-0 max-h-pane-lg flex-col gap-2 overflow-y-auto" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void prepare(); }}>
    <label className="text-meta">고정 이름<Input value={name} maxLength={30} onChange={(event) => setName(event.target.value)} placeholder="happy_dance" required /></label>
    <label className="text-meta">표시 이름<Input value={displayName} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} placeholder="신나는 춤" required /></label>
    <label className="text-meta">태그 (쉼표로 구분)<Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="축하, 춤" /></label>
    <label className="text-meta">사람 얼굴<Select value={face} onChange={(event) => setFace(event.target.value)}><option value="none">사람 얼굴이 없어요</option><option value="self">내 얼굴 한 명이에요</option><option value="other">다른 사람 또는 여러 명이에요</option></Select></label>
    <p className="text-meta text-ink-muted">이름과 그림은 등록 뒤 바꿀 수 없어요. 다른 사람의 얼굴은 당사자에게 직접 올려 달라고 해 주세요.</p>
    <label className="text-meta">출처 링크 (선택)<Input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://giphy.com/gifs/…" /></label>
    <label className="text-meta">직접 올릴 그림<Input type="file" accept={EXPRESSION_FILE_ACCEPT} disabled={!!url} onChange={(event) => setFile(event.target.files?.item(0) ?? null)} /></label>
    {error && <p role="alert" className="text-meta text-danger">{error}</p>}
    <Button type="submit" className="self-end" disabled={busy || offline}>{busy ? "미리보기를 만드는 중" : "미리보기 만들기"}</Button>
  </form>;
}
