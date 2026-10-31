import { useEffect, useId, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { ArrowLeft, MoreHorizontal, Plus } from "lucide-react";
import { fetchRoster } from "@momo/core/lib/api";
import { searchExpressions } from "@momo/core/features/expressions/search";
import { matchesExpressionContract } from "@momo/core/features/expressions/contracts";
import { expressionToken } from "@momo/core/features/expressions/message";
import type { Expression, ExpressionDraft, ExpressionMetadata } from "@momo/core/features/expressions/types";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { Select } from "@/design/ui/select";
import { SegmentedControl } from "@/design/ui/segmented-control";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/design/ui/dropdown-menu";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { loadCatalog } from "@/features/emoji/catalog";
import { ExpressionDraftCard } from "./ExpressionDraftCard";
import { ExpressionMakeForm } from "./ExpressionMakeForm";
import { EXPRESSION_FILE_ACCEPT, validExpressionFile } from "./media";
import { ExpressionImage } from "./ExpressionImage";
import { useExpressions } from "./context";

// 「＋」는 메뉴다: 가져오기(직접 올리기·출처 링크)와 AI와 만들기. 두 길은 권한(canAdd)과 오프라인 규칙이 같다.
type PanelMode = "list" | "import" | "make";
// 잠금의 흐림은 잠금과 한 식이 켠다(#1486 문법). 클래스 글자는 상수로 둬서 JSX 식 안의 문자열로 세지 않는다.
const DIM = "opacity-50";

export function TeamExpressionsPanel({ onPick, purpose, onClose, escapeClaim }: { onPick: (token: string) => void; purpose: "reaction" | "insert"; /** 요청을 보낸 뒤 고르개를 닫는다. 없으면 열어 둔 채로 둔다. */ onClose?: () => void;
  /**
   * 확인 단계가 서 있는 동안 Esc의 임자가 되는 자리. 고르개(Radix 팝오버)가 Esc를 문서 캡처 단계에서 먼저 가져가므로, 고르개가
   * 이 ref를 읽어 확인 단계 취소를 부른다. 확인이 없으면 null이다. 확인 단계에서 Esc가 고르개 통째로 닫으면 안 된다(#4986).
   */
  escapeClaim?: MutableRefObject<(() => void) | null> }) {
  const { store, cache, usage, status, offline } = useExpressions();
  const [query, setQuery] = useState("");
  const [view, setView] = useState("emoji");
  const [mode, setMode] = useState<PanelMode>("list");
  const addTrigger = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const focusTrigger = useRef(false);
  const [admin, setAdmin] = useState(false);
  const [target, setTarget] = useState<{ item: Expression; action: "delete" | "report" } | null>(null);
  // 확인 단계는 이 고르개 안의 단계다. 별도 대화상자(스크림 층 200)가 고르개(표면 층 300) 아래에 깔려서 고르개가 밝게 남았다(#4986).
  // 닫으면 초점이 그 항목의 「관리」로 돌아간다. 목록은 확인 중에 내려가므로 단추 노드를 들고 있지 않고 항목 id로 다시 찾는다.
  const returnFocusTo = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
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
  const items = searchExpressions(cache.items, query.replace(/^:|:$/g, ""), usage).filter((item) => view !== "gif" || item.media?.large.mime === "image/gif");
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
  return <div className="flex min-h-0 flex-col gap-2" data-testid="team-expressions">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-body font-semibold">우리 팀</p>
      {confirming ? null : mode === "list" ? <DropdownMenu><DropdownMenuTrigger asChild disabled={!canAdd || offline}><Button ref={addTrigger} type="button" variant="secondary" size="sm" disabled={!canAdd || offline} data-testid="expression-add-menu"><Plus aria-hidden="true" />추가하기</Button></DropdownMenuTrigger><DropdownMenuContent align="end">
        <DropdownMenuItem data-testid="expression-add-import" onSelect={() => setMode("import")}>가져오기</DropdownMenuItem>
        <DropdownMenuItem data-testid="expression-add-make" onSelect={() => setMode("make")}>AI와 만들기</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu> : <Button ref={backButton} type="button" variant="secondary" size="sm" onClick={backToList}><ArrowLeft aria-hidden="true" />목록으로</Button>}
    </div>
    {!canAdd && <p className="text-meta text-ink-muted">이 팀은 관리자만 새 그림을 올릴 수 있어요.</p>}
    {offline && <InlineBanner message="연결이 끊겼어요. 연결되면 그림을 다시 불러와요." separator={false} />}
    {confirming ? <div role="group" aria-labelledby={confirmTitleId} aria-describedby={confirmBodyId} className="flex flex-col gap-3" data-testid="expression-confirm">
      <p id={confirmTitleId} className="text-title font-semibold text-ink">{target.action === "delete" ? "팀 그림을 삭제할까요?" : "팀 그림을 신고할까요?"}</p>
      <p id={confirmBodyId} className="text-body text-ink-muted">{target.action === "delete" ? "지운 이름은 다시 쓸 수 없어요. 예전 메시지와 반응은 이름 문자열로 표시돼요." : "신고하면 팀 전체에서 즉시 숨겨져요. 신고자와 내용은 관리자만 볼 수 있어요."}</p>
      {target.action === "report" && <label className="text-body">신고 사유<Select value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy}><option value="copyright">저작권</option><option value="face">사람 얼굴</option><option value="other">기타</option></Select></label>}
      {error && <p role="alert" className="text-body text-danger">{error}</p>}
      {/* 진행·잠금 문법(#1486): 보내는 단추는 `aria-busy` + 바뀐 낱말이고 자기 진행으로 잠그지도 흐리지도 않는다. 형제인 「취소」는
          그 진행 때문에 잠기므로 aria-disabled + 흐림 + 가드(closeConfirm)다. 둘 다 네이티브 disabled가 아니라서 초점을 쥔 단추가
          disabled가 되어 초점이 body로 떨어지는 일이 없다(#4986). 연결이 없을 때만 보내는 단추도 잠긴다. */}
      <div className="flex justify-end gap-2"><Button ref={cancelRef} type="button" variant="secondary" aria-disabled={busy || undefined} className={cn(busy && DIM)} onClick={closeConfirm}>취소</Button><Button type="button" variant="destructive" aria-busy={busy || undefined} aria-disabled={offline || undefined} className={cn(offline && DIM)} onClick={() => void confirm()}>{busy ? "처리 중" : target.action === "delete" ? "삭제하기" : "신고하고 숨기기"}</Button></div>
    </div> : mode === "import" ? <ExpressionUploadForm onDone={backToList} /> : mode === "make" ? <ExpressionMakeForm onImport={() => setMode("import")} onClose={onClose} /> : <>
      <SegmentedControl legend="팀 표현 보기" value={view} onValueChange={setView} options={[{ value: "emoji", label: "이모지" }, { value: "sticker", label: "스티커" }, { value: "gif", label: "팀 GIF" }]} />
      <Input ref={searchRef} type="search" aria-label="우리 팀 표현 검색" placeholder="이름, 태그, 초성으로 검색" value={query} onChange={(event) => setQuery(event.target.value)} />
      <p className="text-meta text-ink-muted">한 보관함의 그림을 반응이나 메시지에 쓸 수 있어요.</p>
      {status === "loading" ? <Skeleton ready={false} rows={4} /> : status === "error" ? <InlineBanner message="팀 그림을 불러오지 못했어요. 다시 시도해 주세요." actionLabel="다시 시도" onAction={() => void store.refresh()} separator={false} /> : items.length === 0 ? <EmptyInvite headline={query ? "맞는 팀 그림이 없어요" : "아직 팀 그림이 없어요"} actions={<Button type="button" variant="secondary" disabled={!canAdd || offline} onClick={() => query ? setQuery("") : setMode("import")}>{query ? "검색 지우기" : "첫 그림 올리기"}</Button>} /> :
        <ul ref={listRef} className="min-h-0 max-h-pane overflow-y-auto" aria-label="팀 표현 목록">{items.map((item) => <li key={item.id} className="flex items-center gap-2 border-b border-line py-1">
          <button type="button" disabled={offline} className="tap-target flex min-w-0 flex-1 items-center gap-2 rounded-md p-2 text-left hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring disabled:opacity-50" aria-label={`${item.displayName} ${purpose === "reaction" ? "반응으로 고르기" : "메시지에 넣기"}`} onClick={() => {
            const active = store.getSnapshot().cache.items.find((entry) => entry.id === item.id && entry.name === item.name);
            if (active?.status === "active") onPick(expressionToken(active.name));
          }}><ExpressionImage item={item} size={view === "sticker" ? "medium" : "reaction"} still /><span className="min-w-0 break-words text-body">{item.displayName}<span className="block break-all font-mono text-meta text-ink-muted">:{item.name}:</span></span></button>
          <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={`${item.displayName} 관리`} data-manage={item.id}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger><DropdownMenuContent>
            <DropdownMenuItem onSelect={() => { setError(null); setTarget({ item, action: "report" }); }}>신고하기</DropdownMenuItem>
            <DropdownMenuItem disabled={item.createdBy !== store.memberId && !admin} onSelect={() => { setError(null); setTarget({ item, action: "delete" }); }}>삭제하기{item.createdBy !== store.memberId && !admin ? " (만든 사람·관리자만)" : ""}</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu>
        </li>)}</ul>}
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
    if (!url && (!file || !validExpressionFile(file))) { setError("5 MiB 이하의 PNG, JPEG, WebP 또는 GIF를 골라 주세요."); return; }
    if (url && !matchesExpressionContract("ImportRequest", { ...metadata, url })) { setError("공개 HTTPS 출처 링크를 넣어 주세요."); return; }
    lock.current = true; setBusy(true); setError(null);
    try {
      const standard = await loadCatalog();
      if (standard.some((entry) => entry.shortcodes.includes(name))) { setError("표준 이모지와 겹치는 이름이에요. 다른 이름을 써 주세요."); return; }
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
