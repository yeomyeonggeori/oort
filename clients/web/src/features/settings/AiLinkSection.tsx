import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import {
  deleteProviderLink,
  fetchProviderLink,
  putProviderLink,
  testProviderLink,
  type ProviderLink,
  type ProviderLinkInput,
  type ProviderLinkTest,
} from "@momo/core/features/settings/api";
import {
  choiceLabel,
  errorMessage,
  isOperatorDenied,
  maskedBearer,
  PROVIDER_MODES,
  providerSourceLabel,
  providerTestMessage,
} from "@momo/core/features/settings/model";
import {
  ChoiceRadios,
  ConfirmButton,
  Field,
  KeyValueRows,
  OperatorNotice,
  SectionShell,
  StatusChip,
  type KeyValue,
} from "./SettingsFields";
import { AiLinkChain, ChainProbeResult } from "./AiLinkChain";
import { parseProbeEntries } from "@momo/core/features/settings/chainModel";
import { arrayField } from "@momo/core/lib/wire";
import {
  accessTokenStatus,
  buildOAuthLinkBody,
  CHATGPT_OAUTH_BASE_URL,
  credentialKind,
  credentialKindLabel,
  credentialMeta,
  formatMoment,
  grantPreviewRows,
  OAUTH_CREDENTIAL_KIND,
  parseAuthJson,
  type LinkFormField,
  type ProviderOAuthGrant,
  validateBaseUrl,
} from "./oauthGrant";

// =============================================================================
// AI 연결 (R-1 §5): the instance-global provider link, GET/PUT/DELETE plus the
// reachability probe. ADR-0004 is the reason this surface looks the way it
// does: the credential is write-only, so the panel can show whether one exists
// and a masked tail, and nothing else. There is no "reveal key".
//
// U3 adds the second registration method the server has accepted since ADR-0147
// landed: a ChatGPT subscription OAuth grant. It is a SECOND METHOD rather than
// a second section because a link carries exactly one credential — the server
// 400s on bearer+oauth together — so presenting them as parallel forms would
// draw a screen where two valid-looking states cannot both be saved.
//
// 결정 3 is why this is a paste box and not a "ChatGPT로 로그인" button: momo
// relays no browser OAuth flow, the operator logs in with their own local Codex
// CLI, and this surface's job is to accept the result of that. A button would
// promise a flow that does not exist.
// =============================================================================

/** Registration methods. Verb-free ids; the server sees neither of these. */
const LINK_METHODS = [
  {
    id: "key",
    label: "키",
    detail: "provider가 발급한 API 키를 직접 넣습니다. 제품 기본 경로입니다.",
  },
  {
    id: "oauth",
    label: "ChatGPT 계정 (OAuth)",
    detail:
      "로컬 Codex CLI 로그인이 만든 auth.json 을 붙여넣습니다. 개인 구독으로 동작하는 내부용 경로입니다.",
  },
];

type LinkMethod = "key" | "oauth";

function statusChip(link: ProviderLink) {
  if (link.configured && link.keyConfigured) {
    return <StatusChip tone="ok">연결됨</StatusChip>;
  }
  if (link.configured) {
    // An OAuth link reports `keyConfigured` from the GRANT, not from the access
    // token it happens to be holding, so this branch still means what it always
    // meant: a row exists and it cannot serve a turn.
    return <StatusChip tone="warn">자격증명 없음</StatusChip>;
  }
  return <StatusChip tone="muted">연결 안 됨</StatusChip>;
}

/** 3R M4: 와이어 가용성 값을 사용자 어휘로. 미지 값은 원문 유지. */
function availabilityLabel(availability: string): string {
  const known: Record<string, string> = {
    live: "연결됨",
    available: "연결됨",
    mock: "모의 응답",
    unavailable: "연결 안 됨",
  };
  return known[availability] ?? availability;
}

export function AiLinkSection({ offline }: { offline: boolean }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["settings", "provider-link"],
    queryFn: fetchProviderLink,
    retry: false,
  });

  const [editing, setEditing] = useState(false);
  const [method, setMethod] = useState<LinkMethod>("key");
  const [baseUrl, setBaseUrl] = useState("");
  const [bearer, setBearer] = useState("");
  const [mode, setMode] = useState("external-hermes");
  // The pasted auth.json. Held only while the form is open and cleared the
  // moment a save lands or the form closes: it is a whole credential document,
  // and the one place it is allowed to exist is the control the operator is
  // looking at. Never logged, never echoed, never written anywhere else.
  const [paste, setPaste] = useState("");
  // The parsed grant, kept while the raw document is NOT. Both hold the same
  // secret in memory and there is no avoiding that (it has to be sent), but
  // only one of them has to be legible on screen, and that one is neither.
  const [grant, setGrant] = useState<ProviderOAuthGrant | null>(null);
  // What each method was last holding in the address box.
  //
  // Making the address follow the method fixed a hint that lied about the value
  // under it, and bought a worse bug: the address became a function of the
  // RADIO, with no memory of what the operator had. Opening a link on a custom
  // tenant, glancing at the other method and coming back rewrote the endpoint
  // to the default — and the button underneath says "연결 교체 저장", so a look
  // turned into an edit of a field nobody touched. The key side went blank the
  // same way.
  //
  // Suggesting and owning are different things. The method proposes a starting
  // value the first time it is chosen; after that the box belongs to whoever
  // typed in it, and a round trip is a look.
  const [addressMemory, setAddressMemory] = useState<
    Partial<Record<LinkMethod, string>>
  >({});
  const [accountLabel, setAccountLabel] = useState("");
  const [fieldError, setFieldError] = useState<
    Partial<Record<LinkFormField, string>>
  >({});
  const [probe, setProbe] = useState<ProviderLinkTest | null>(null);
  // The chain block below owns its own draft, and the probe table above it is
  // numbered by the SAVED order. When the two disagree the table says so
  // rather than letting one screen carry two meanings of "3차".
  const [chainPending, setChainPending] = useState(false);

  /**
   * A successful paste is read and then TAKEN OFF THE SCREEN.
   *
   * The key box next door has been `type="password"` all along, and a refresh
   * token outlives an API key by a wide margin — so leaving the longer-lived
   * secret legible was the wrong half of that pair to leave uncovered. It was
   * legible for the whole form session, too: after pasting, the operator still
   * has to fill the account label and reach the save button, so screen-share
   * and shoulder exposure lasted until submit.
   *
   * Clearing costs nothing because the raw text was only ever answering one
   * question — "is this the right file" — and the preview below answers it
   * better, by naming what was found instead of showing it.
   *
   * A FAILED parse keeps the text: the person has to see the document to fix
   * it. The error itself still waits for submit, because a half-finished paste
   * is not a mistake and red text on every keystroke trains people to ignore it.
   */
  function readPaste(next: string) {
    const result = parseAuthJson(next);
    if (result.ok) {
      setGrant(result.grant);
      setPaste("");
      setFieldError((prev) => ({ ...prev, paste: undefined }));
      return;
    }
    setGrant(null);
    setPaste(next);
  }

  const previewRef = useRef<HTMLDivElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const hadGrant = useRef(false);

  // Swapping the paste box for the read-back removes the element the person was
  // just typing into, and a focused element that leaves the DOM drops focus to
  // <body> — the next Tab restarts from the top of the page. This file already
  // makes that argument twice about `aria-disabled` (SettingsFields), so the
  // swap does not get to be the exception. Focus follows the content that
  // replaced it, in both directions.
  useEffect(() => {
    const has = Boolean(grant);
    if (has !== hadGrant.current) {
      if (has) previewRef.current?.focus();
      else if (method === "oauth") pasteRef.current?.focus();
    }
    hadGrant.current = has;
  }, [grant, method]);

  const invalidate = () =>
    client.invalidateQueries({ queryKey: ["settings", "provider-link"] });

  const save = useMutation({
    mutationFn: (input: ProviderLinkInput) => putProviderLink(input),
    onSuccess: () => {
      closeForm();
      setProbe(null);
      void invalidate();
    },
  });

  const unlink = useMutation({
    mutationFn: deleteProviderLink,
    onSuccess: () => {
      setProbe(null);
      void invalidate();
    },
  });

  const check = useMutation({
    mutationFn: testProviderLink,
    onSuccess: setProbe,
  });

  const busy = save.isPending || unlink.isPending || check.isPending;

  function closeForm() {
    setEditing(false);
    setBearer("");
    setPaste("");
    setGrant(null);
    setAccountLabel("");
    setAddressMemory({});
    setFieldError({});
  }

  function startEditing(link: ProviderLink) {
    // Open on the method this link already uses, so "연결 수정" on an OAuth link
    // is not a form asking for an API key.
    const registered: LinkMethod =
      credentialKind(link) === OAUTH_CREDENTIAL_KIND ? "oauth" : "key";
    setMethod(registered);
    // Prefill only from a stored link. The environment fallback is a mock
    // address, and offering it as the starting value for a real provider would
    // be a suggestion, not a default. The OAuth address is the exception and is
    // a measurement rather than a suggestion: it is the one endpoint a ChatGPT
    // grant can reach (see CHATGPT_OAUTH_BASE_URL).
    if (link.configured) setBaseUrl(link.baseUrl);
    else setBaseUrl(registered === "oauth" ? CHATGPT_OAUTH_BASE_URL : "");
    setMode(link.configured ? link.mode : "external-hermes");
    setAccountLabel(credentialMeta(link)?.accountLabel ?? "");
    setBearer("");
    setPaste("");
    setGrant(null);
    setAddressMemory({});
    setFieldError({});
    setEditing(true);
  }

  /**
   * The starting value a method offers the FIRST time it is chosen.
   *
   * The key method offers nothing on purpose: the environment fallback is a
   * mock address, so proposing it would be a suggestion rather than a default.
   * The OAuth default is a measurement, not a preference (CHATGPT_OAUTH_BASE_URL).
   */
  function defaultAddress(chosen: LinkMethod): string {
    return chosen === "oauth" ? CHATGPT_OAUTH_BASE_URL : "";
  }

  function switchMethod(next: string) {
    const chosen: LinkMethod = next === "oauth" ? "oauth" : "key";
    if (chosen === method) return;
    setMethod(chosen);
    setFieldError({});
    // Never carry a credential across methods: the two boxes hold different
    // kinds of secret and the server accepts exactly one of them.
    setBearer("");
    setPaste("");
    setGrant(null);
    // The address belongs to the CREDENTIAL, not to the form. It used to be
    // filled only when empty, which meant switching a saved key link to OAuth
    // left `https://api.openai.com/v1` sitting under a hint calling it "ChatGPT
    // 구독 연결이 실제로 닿는 주소" — the hint lying about the value directly
    // beneath it, and the mismatch invisible until the first turn failed in the
    // worker (validation only checks the scheme).
    //
    // So the address moves with the method, in both directions. A different
    // tenant is one edit away, which is the case the hint actually describes.
    // `??`, not `||`: an operator who deliberately emptied the box gets their
    // empty box back rather than the suggestion they just rejected.
    const remembered = { ...addressMemory, [method]: baseUrl };
    setAddressMemory(remembered);
    setBaseUrl(remembered[chosen] ?? defaultAddress(chosen));
  }

  // Both methods report AT the field. They did not: the key path piled the same
  // address sentence at the bottom of the form, ~355px below the box it was
  // about and under three unrelated radios, so flipping one radio made the
  // identical sentence move house — and only one of the two positions bound the
  // message to its input for a screen reader. One form, one rule.
  function submitKey() {
    const addressError = validateBaseUrl(baseUrl);
    if (addressError) {
      setFieldError({ [addressError.field]: addressError.message });
      return;
    }
    if (!bearer.trim()) {
      setFieldError({
        bearer: "키를 입력하세요. 저장된 키는 다시 내려오지 않으므로 매번 새로 입력합니다.",
      });
      return;
    }
    setFieldError({});
    save.mutate({ baseUrl: baseUrl.trim(), bearer, mode });
  }

  function submitOAuth() {
    // The grant normally arrives from `readPaste`; re-parsing here is the path
    // for a box that never parsed, and it exists to produce the field error.
    let resolved = grant;
    if (!resolved) {
      const parsedResult = parseAuthJson(paste);
      if (!parsedResult.ok) {
        setFieldError({ [parsedResult.error.field]: parsedResult.error.message });
        return;
      }
      resolved = parsedResult.grant;
    }
    const built = buildOAuthLinkBody({ baseUrl, accountLabel, grant: resolved });
    if (!built.ok) {
      setFieldError({ [built.error.field]: built.error.message });
      return;
    }
    setFieldError({});
    save.mutate(built.body);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (method === "oauth") submitOAuth();
    else submitKey();
  }

  const lines = [
    "에이전트가 사용할 provider를 이 서버 전체에 하나로 연결합니다.",
    "자격증명은 이 서버에만 저장되고 응답으로 다시 내려오지 않습니다. 저장한 뒤에는 등록 여부와 마지막 4자리만 보입니다.",
  ];

  if (query.isPending) {
    return (
      <SectionShell title="AI 연결" lines={lines}>
        <SkeletonRows rows={4} />
      </SectionShell>
    );
  }

  if (query.isError) {
    return (
      <SectionShell title="AI 연결" lines={lines}>
        {isOperatorDenied(query.error) ? (
          <OperatorNotice
            who="provider 연결은 이 서버의 운영자만 바꿀 수 있습니다."
            contact="연결이 필요하면 이 서버를 운영하는 사람에게 문의하세요."
          />
        ) : (
          <InlineBanner
            message={errorMessage(query.error)}
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="ai-link-error"
          />
        )}
      </SectionShell>
    );
  }

  const link = query.data;
  // Parsed rather than trusted: `entries` is an ADR-0135 D1 addition, so a
  // server that predates it omits the key and anything in front of it can
  // answer a body of another shape entirely. `parseProbeEntries` is total, so
  // an unreadable answer degrades to the MOMO-572 single-hop sentence below
  // instead of throwing inside render (see chainModel).
  const probeEntries = parseProbeEntries(arrayField(probe, "entries"));
  const diagnostics = (arrayField(link, "diagnostics") ?? []).filter(
    (line): line is string => typeof line === "string"
  );

  // Same reading discipline for the ADR-0147 fields: a server built before it
  // omits both, and that has to read as "this server has no OAuth link" rather
  // than as an empty one.
  const kind = credentialKind(link);
  const meta = credentialMeta(link);
  const isOAuthLink = kind === OAUTH_CREDENTIAL_KIND;

  // 연결 헬스는 한 줄씩 붙는 목록이지 고정 슬롯이 아니다. U1 감사가 M-10(폰
  // "연결 중..." 무한 표시)의 수리를 이 축으로 이관해 두었고, 그 항목은 결국
  // 이 카드에 "실시간 레일" 한 줄로 들어온다. 그래서 행은 조건부 push로 쌓고
  // 고정 배열로 쓰지 않는다 - 나중에 한 줄을 받는 데 구조 변경이 필요 없다.
  // (이슈 1047 범위 아님. 여지만 두고 여기서 구현하지 않는다.)
  const statusRows: KeyValue[] = [
    { key: "등록 방식", value: credentialKindLabel(kind) },
    { key: "모드", value: choiceLabel(PROVIDER_MODES, link.mode) },
  ];
  if (isOAuthLink && meta) {
    statusRows.push({
      key: "계정",
      value: meta.accountLabel ?? "라벨 없음. 연결 수정에서 적어 두세요",
      prose: true,
    });
    // The stored `bearerLast4` of an OAuth link is the tail of the SHORT-LIVED
    // access token, not of a saved key, so "저장된 키" would name the wrong
    // thing. The token's own row says what is actually true about it.
    //
    // Colour reinforces the sentence and never replaces it: the row already
    // reads "만료됨. 다음 턴에 서버가 갱신합니다" in words, and --warn is applied
    // only to the one state an operator might want to look twice at. A live
    // token stays ink, because painting the normal case green is decoration.
    //
    // All three tones now reach the screen. `muted` used to be computed and
    // dropped, so "없음. 다음 턴에 서버가 발급합니다" stood at full --ink weight,
    // as loud as a real value; a tone that is calculated and discarded is a
    // tone the next reader will assume is honoured.
    const token = accessTokenStatus(meta, Date.now());
    statusRows.push({
      key: "액세스 토큰",
      prose: true,
      value:
        token.tone === "warn" ? (
          <span className="text-warn">{token.text}</span>
        ) : token.tone === "muted" ? (
          <span className="text-ink-muted">{token.text}</span>
        ) : (
          token.text
        ),
    });
  } else {
    statusRows.push({
      key: "저장된 키",
      value: maskedBearer(link.bearerLast4),
      numeric: true,
    });
  }
  statusRows.push({ key: "가용성", value: availabilityLabel(link.availability) });
  if (link.updatedAtMs) {
    // Not `numeric`: these two rows come out of the SAME `formatMoment`, and
    // marking one of them tabular set "2026. 7. 26. 오전 2:20:00" in mono beside
    // its proportional twin. tabular-nums earns its keep in a column of figures,
    // not in a localized date sentence.
    statusRows.push({ key: "마지막 저장", value: formatMoment(link.updatedAtMs) });
  }
  if (probe) {
    // Client-session only, and labelled as such: the server keeps no record of
    // when anyone last probed, so calling this "마지막 확인" flat would claim a
    // history this panel does not have.
    statusRows.push({
      key: "이 화면에서 마지막 확인",
      value: formatMoment(probe.checkedAtMs),
    });
  }

  return (
    <SectionShell title="AI 연결" lines={lines}>
      {!link.configured && !editing && (
        <EmptyInvite
          headline="에이전트가 쓸 AI를 연결하세요."
          detail={`지금은 ${providerSourceLabel(link.source)}이며, 모드는 ${choiceLabel(
            PROVIDER_MODES,
            link.mode
          )}입니다.`}
          actions={
            <Button size="sm" onClick={() => startEditing(link)}>
              provider 연결하기
            </Button>
          }
          testId="ai-link-empty"
        />
      )}

      {link.configured && (
        <div
          className="flex flex-col gap-3 rounded-md border border-line bg-surface-raised p-4"
          data-testid="ai-link-card"
        >
          {/* While the form is open this card describes the PAST, and it has to
              say so. Without this line the panel showed "등록 방식 / 키" in the
              card and "등록 방식 / ChatGPT 계정" in the form legend directly
              below it: the same label twice, two different values, and no
              sentence anywhere saying which one is in force. It also never said
              that saving REPLACES what the card describes. */}
          {editing && (
            <p
              className="break-keep text-meta text-ink-muted"
              data-testid="ai-link-card-tense"
            >
              지금 저장되어 있는 연결입니다. 아래 폼을 저장하면 이 연결을 대체합니다.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-body font-medium text-ink">
              {link.endpointLabel}
            </h3>
            {statusChip(link)}
            <StatusChip tone="muted">{providerSourceLabel(link.source)}</StatusChip>
            {/* Muted, not warn. This is a CLASSIFICATION of the link, true for
                as long as the link exists; --warn is for what is happening now
                and might want an action. */}
            {isOAuthLink && <StatusChip tone="muted">개인 계정 · 내부용</StatusChip>}
          </div>

          <KeyValueRows rows={statusRows} />

          {/* The server's own sentence, rendered verbatim so the settings panel,
              the agent surfaces and the docs cannot drift into three different
              descriptions of the same constraint (ADR-0147 라벨 요구). */}
          {/* Set off by a rule as a QUOTATION, not painted as a warning. It used
              to be --warn, pixel-identical to the diagnostics list right under
              it — so a standing policy sentence and a 429 that happened ten
              seconds ago were the same colour, the same size, in the same place,
              and the card carried four ambers meaning four different things.
              Amber now means one thing: live, and possibly yours to act on. */}
          {isOAuthLink && meta?.notice && (
            <p
              className="border-l-2 border-line pl-3 break-keep text-meta text-ink-muted"
              data-testid="ai-link-oauth-notice"
            >
              {meta.notice}
            </p>
          )}

          {diagnostics.length > 0 && (
            <ul className="flex flex-col gap-1">
              {diagnostics.map((line) => (
                <li key={line} className="text-meta text-warn">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {editing ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={submit}
          data-testid="ai-link-form"
        >
          <ChoiceRadios
            name="provider-method"
            legend={link.configured ? "바꿀 등록 방식" : "등록 방식"}
            choices={LINK_METHODS}
            value={method}
            onChange={switchMethod}
            testId="ai-link-method"
          />

          <Field
            label="provider 주소"
            htmlFor="provider-base-url"
            hint={
              method === "oauth"
                ? "ChatGPT 구독 연결이 실제로 닿는 주소입니다. 다른 테넌트를 쓸 때만 바꾸세요."
                : "예: https://api.example.com/v1"
            }
            error={fieldError.baseUrl}
          >
            <Input
              id="provider-base-url"
              name="baseUrl"
              value={baseUrl}
              autoComplete="off"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </Field>

          {method === "key" ? (
            <>
              <Field
                label="키"
                htmlFor="provider-bearer"
                hint="입력한 값은 저장 즉시 암호화되며 화면으로 다시 돌아오지 않습니다."
                error={fieldError.bearer}
              >
                <Input
                  id="provider-bearer"
                  name="bearer"
                  type="password"
                  value={bearer}
                  autoComplete="off"
                  onChange={(e) => setBearer(e.target.value)}
                />
              </Field>

              <ChoiceRadios
                name="provider-mode"
                legend="모드"
                choices={PROVIDER_MODES}
                value={mode}
                onChange={setMode}
              />
            </>
          ) : (
            <>
              {/* Two states of ONE control. Before a successful parse it is a
                  box to paste into; after one it is a read-back of what was
                  found, and the document itself is gone from the screen.
                  Presence, never values (ADR-0004 #2/#5). */}
              {grant ? (
                <div
                  ref={previewRef}
                  tabIndex={-1}
                  className="flex flex-col gap-2 rounded-md border border-line bg-surface-raised p-4 focus-visible:focus-ring"
                  data-testid="ai-link-oauth-preview"
                >
                  {/* The box vanishing is the only signal a sighted user gets.
                      `role="status"` makes the exchange audible too, instead of
                      leaving a screen-reader user with a control that silently
                      stopped existing. */}
                  <p className="break-keep text-meta text-ink-muted" role="status">
                    auth.json 을 읽었습니다. 붙여넣은 원문은 화면에서 지웠습니다.
                  </p>
                  <KeyValueRows rows={grantPreviewRows(grant)} />
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setGrant(null);
                        setFieldError((prev) => ({ ...prev, paste: undefined }));
                      }}
                      data-testid="ai-link-oauth-repaste"
                    >
                      다시 붙여넣기
                    </Button>
                  </div>
                </div>
              ) : (
                <Field
                  label="auth.json"
                  htmlFor="provider-oauth-paste"
                  hint="로컬에서 codex 로그인을 마친 뒤 ~/.codex/auth.json 내용을 그대로 붙여넣으세요. 읽고 나면 원문은 화면에서 지웁니다."
                  error={fieldError.paste}
                >
                  {/* 이 번들에는 textarea 프리미티브가 없다. Input과 같은 토큰
                      계열을 쓰되 높이(rows)와 세로 패딩(py-2)이 다르고,
                      transition-colors/tap-target은 붙이지 않는다. */}
                  <textarea
                    ref={pasteRef}
                    id="provider-oauth-paste"
                    name="oauthPaste"
                    value={paste}
                    rows={6}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => readPaste(e.target.value)}
                    data-testid="ai-link-oauth-paste"
                    className="w-full resize-y rounded-sm border border-line-strong bg-transparent px-3 py-2 font-mono text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </Field>
              )}

              <Field
                label="누구의 구독인가"
                htmlFor="provider-oauth-account"
                hint="이 연결이 쓰는 사용량은 그 사람의 ChatGPT 구독 한도에서 나갑니다. 저장하면 위 연결 카드의 「계정」 줄에 그대로 표시됩니다."
                error={fieldError.accountLabel}
              >
                <Input
                  id="provider-oauth-account"
                  name="accountLabel"
                  value={accountLabel}
                  autoComplete="off"
                  onChange={(e) => setAccountLabel(e.target.value)}
                  data-testid="ai-link-oauth-label"
                />
              </Field>

              {/* The mode radios are absent from this branch, and a control that
                  vanishes should say what took its place. */}
              <p className="break-keep text-meta text-ink-muted">
                모드는 외부 provider로 고정됩니다. ChatGPT 구독 연결이 곧 외부
                provider 경계이므로 고를 것이 없습니다.
              </p>
            </>
          )}

          {save.isError && (
            <p className="text-meta text-danger" role="alert">
              {errorMessage(save.error)}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={offline || busy}>
              {save.isPending
                ? "저장 중"
                : link.configured
                  ? "연결 교체 저장"
                  : "연결 저장"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={closeForm}>
              취소
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {link.configured && (
            <Button size="sm" onClick={() => startEditing(link)}>
              연결 수정
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={offline || busy}
            onClick={() => check.mutate()}
          >
            {check.isPending ? "확인 중" : "연결 확인"}
          </Button>
          {link.configured && (
            <ConfirmButton
              label="연결 해제"
              question="저장된 주소와 자격증명을 지웁니다."
              confirmLabel="해제"
              disabled={offline || busy}
              onConfirm={() => unlink.mutate()}
              testId="ai-link-unlink"
            />
          )}
        </div>
      )}

      {check.isError && (
        <p className="text-meta text-danger" role="alert">
          {errorMessage(check.error)}
        </p>
      )}
      {unlink.isError && (
        <p className="text-meta text-danger" role="alert">
          {errorMessage(unlink.error)}
        </p>
      )}
      {/* One probe, two shapes. A server that carries the ADR-0135 D1 chain
          answers `entries[]`, and then the per-hop table IS the result: its
          first row is position 0, so repeating the single-hop sentence above it
          would state the same fact twice in two different vocabularies. A
          server built before the chain landed answers the MOMO-572 body, and
          that sentence stays exactly as it was.

          Both live OUTSIDE the status card, and that placement is load-bearing:
          the card only exists once a link is configured, and the probe answer
          people most need to read — "저장된 키가 없습니다" — belongs to the case
          where there is no card to put it in. */}
      {probe &&
        (probeEntries.length > 0 ? (
          <ChainProbeResult
            cascadeOk={probe.cascadeOk === true}
            entries={probeEntries}
            checkedAtMs={probe.checkedAtMs}
            chainPending={chainPending}
          />
        ) : (
          <p
            className={probe.ok ? "text-meta text-ok" : "text-meta text-warn"}
            role="status"
            data-testid="ai-link-probe"
          >
            {providerTestMessage(probe)}
          </p>
        ))}

      {/* A saved chain makes the table above describe a cascade that no longer
          exists, exactly as save/unlink do for the singleton. Same clear. */}
      <AiLinkChain
        offline={offline}
        onSaved={() => setProbe(null)}
        onPendingChange={setChainPending}
      />
    </SectionShell>
  );
}
