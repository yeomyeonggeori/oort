import { useMemo, useState } from "react";
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
  type OAuthFormField,
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
  const [accountLabel, setAccountLabel] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<
    Partial<Record<OAuthFormField, string>>
  >({});
  const [probe, setProbe] = useState<ProviderLinkTest | null>(null);
  // The chain block below owns its own draft, and the probe table above it is
  // numbered by the SAVED order. When the two disagree the table says so
  // rather than letting one screen carry two meanings of "3차".
  const [chainPending, setChainPending] = useState(false);

  // Parsed on every change so a good paste confirms itself immediately, but the
  // FAILURE is not shown here: a half-typed document is not a mistake, it is a
  // paste in progress, and red text on every keystroke would train the operator
  // to ignore it. Errors appear on submit, where they are answerable.
  const parsedGrant = useMemo(() => {
    const result = parseAuthJson(paste);
    return result.ok ? result.grant : null;
  }, [paste]);

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
    setAccountLabel("");
    setFormError(null);
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
    setFormError(null);
    setFieldError({});
    setEditing(true);
  }

  function switchMethod(next: string) {
    const chosen: LinkMethod = next === "oauth" ? "oauth" : "key";
    setMethod(chosen);
    setFormError(null);
    setFieldError({});
    // Never carry a credential across methods: the two boxes hold different
    // kinds of secret and the server accepts exactly one of them.
    setBearer("");
    setPaste("");
    if (chosen === "oauth" && !baseUrl.trim()) setBaseUrl(CHATGPT_OAUTH_BASE_URL);
  }

  function submitKey() {
    const url = baseUrl.trim();
    if (!url) {
      setFormError("provider 주소를 입력하세요.");
      return;
    }
    if (!/^https?:\/\/.+/.test(url)) {
      setFormError("주소는 http:// 또는 https:// 로 시작해야 합니다.");
      return;
    }
    if (!bearer.trim()) {
      setFormError("키를 입력하세요. 저장된 키는 다시 내려오지 않으므로 매번 새로 입력합니다.");
      return;
    }
    setFormError(null);
    save.mutate({ baseUrl: url, bearer, mode });
  }

  function submitOAuth() {
    const parsedResult = parseAuthJson(paste);
    if (!parsedResult.ok) {
      setFieldError({ [parsedResult.error.field]: parsedResult.error.message });
      return;
    }
    const built = buildOAuthLinkBody({
      baseUrl,
      accountLabel,
      grant: parsedResult.grant,
    });
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

  const statusRows: KeyValue[] = [
    { key: "등록 방식", value: credentialKindLabel(kind) },
    { key: "모드", value: choiceLabel(PROVIDER_MODES, link.mode) },
  ];
  if (isOAuthLink && meta) {
    statusRows.push({
      key: "계정",
      value: meta.accountLabel ?? "라벨 없음. 연결 수정에서 적어 두세요",
    });
    // The stored `bearerLast4` of an OAuth link is the tail of the SHORT-LIVED
    // access token, not of a saved key, so "저장된 키" would name the wrong
    // thing. The token's own row says what is actually true about it.
    //
    // Colour reinforces the sentence and never replaces it: the row already
    // reads "만료됨. 다음 턴에 서버가 갱신합니다" in words, and --warn is applied
    // only to the one state an operator might want to look twice at. A live
    // token stays ink, because painting the normal case green is decoration.
    const token = accessTokenStatus(meta, Date.now());
    statusRows.push({
      key: "액세스 토큰",
      value:
        token.tone === "warn" ? (
          <span className="text-warn">{token.text}</span>
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
    statusRows.push({
      key: "마지막 저장",
      value: formatMoment(link.updatedAtMs),
      numeric: true,
    });
  }
  if (probe) {
    // Client-session only, and labelled as such: the server keeps no record of
    // when anyone last probed, so calling this "마지막 확인" flat would claim a
    // history this panel does not have.
    statusRows.push({
      key: "이 화면에서 마지막 확인",
      value: formatMoment(probe.checkedAtMs),
      numeric: true,
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
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-body font-medium text-ink">
              {link.endpointLabel}
            </h3>
            {statusChip(link)}
            <StatusChip tone="muted">{providerSourceLabel(link.source)}</StatusChip>
            {isOAuthLink && <StatusChip tone="warn">개인 계정 · 내부용</StatusChip>}
          </div>

          <KeyValueRows rows={statusRows} />

          {/* The server's own sentence, rendered verbatim so the settings panel,
              the agent surfaces and the docs cannot drift into three different
              descriptions of the same constraint (ADR-0147 라벨 요구). */}
          {isOAuthLink && meta?.notice && (
            <p className="break-keep text-meta text-warn" data-testid="ai-link-oauth-notice">
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
            legend="등록 방식"
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
              <Field
                label="auth.json"
                htmlFor="provider-oauth-paste"
                hint="로컬에서 codex 로그인을 마친 뒤 ~/.codex/auth.json 내용을 그대로 붙여넣으세요. 저장 즉시 암호화되며 화면으로 다시 돌아오지 않습니다."
                error={fieldError.paste}
              >
                {/* 이 번들에는 textarea 프리미티브가 없다. Input과 같은 토큰
                    클래스를 쓰되 높이만 다르다. */}
                <textarea
                  id="provider-oauth-paste"
                  name="oauthPaste"
                  value={paste}
                  rows={6}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setPaste(e.target.value)}
                  data-testid="ai-link-oauth-paste"
                  className="w-full resize-y rounded-sm border border-line-strong bg-transparent px-3 py-2 font-mono text-body text-ink placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
                />
              </Field>

              {/* Presence, never values: the operator needs to know they pasted
                  the right FILE, and that question is answerable without this
                  surface putting a credential back on screen (ADR-0004 #2/#5). */}
              {parsedGrant && (
                <div
                  className="flex flex-col gap-2 rounded-md border border-line bg-surface-raised p-4"
                  data-testid="ai-link-oauth-preview"
                >
                  <p className="text-meta text-ink-muted">읽은 내용</p>
                  <KeyValueRows rows={grantPreviewRows(parsedGrant)} />
                </div>
              )}

              <Field
                label="누구의 구독인가"
                htmlFor="provider-oauth-account"
                hint="이 연결이 쓰는 사용량은 그 사람의 ChatGPT 구독 한도에서 나갑니다. 나중에 이 판에서 이 문장이 그대로 보입니다."
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
            </>
          )}

          {formError && (
            <p className="text-meta text-danger" role="alert">
              {formError}
            </p>
          )}
          {save.isError && (
            <p className="text-meta text-danger" role="alert">
              {errorMessage(save.error)}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={offline || busy}>
              {save.isPending ? "저장 중" : "연결 저장"}
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
