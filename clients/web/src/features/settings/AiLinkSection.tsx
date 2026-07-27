import { useState } from "react";
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
  type ProviderLinkTest,
} from "./api";
import {
  choiceLabel,
  errorMessage,
  isOperatorDenied,
  maskedBearer,
  PROVIDER_MODES,
  providerSourceLabel,
  providerTestMessage,
} from "./model";
import {
  ChoiceRadios,
  ConfirmButton,
  Field,
  KeyValueRows,
  OperatorNotice,
  SectionShell,
  StatusChip,
} from "./SettingsFields";
import { AiLinkChain, ChainProbeResult } from "./AiLinkChain";
import { parseProbeEntries } from "./chainModel";
import { arrayField } from "@/lib/wire";

// =============================================================================
// AI 연결 (R-1 §5): the instance-global provider link, GET/PUT/DELETE plus the
// reachability probe. ADR-0004 is the reason this surface looks the way it
// does: the bearer is write-only, so the panel can show whether a key exists
// and its last four characters, and nothing else. There is no "reveal key".
// =============================================================================

function statusChip(link: ProviderLink) {
  if (link.configured && link.keyConfigured) {
    return <StatusChip tone="ok">연결됨</StatusChip>;
  }
  if (link.configured) {
    return <StatusChip tone="warn">키 없음</StatusChip>;
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
  const [baseUrl, setBaseUrl] = useState("");
  const [bearer, setBearer] = useState("");
  const [mode, setMode] = useState("external-hermes");
  const [formError, setFormError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProviderLinkTest | null>(null);
  // The chain block below owns its own draft, and the probe table above it is
  // numbered by the SAVED order. When the two disagree the table says so
  // rather than letting one screen carry two meanings of "3차".
  const [chainPending, setChainPending] = useState(false);

  const invalidate = () =>
    client.invalidateQueries({ queryKey: ["settings", "provider-link"] });

  const save = useMutation({
    mutationFn: () => putProviderLink({ baseUrl: baseUrl.trim(), bearer, mode }),
    onSuccess: () => {
      setEditing(false);
      setBearer("");
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

  function startEditing(link: ProviderLink) {
    // Prefill only from a stored link. The environment fallback is a mock
    // address, and offering it as the starting value for a real provider would
    // be a suggestion, not a default.
    setBaseUrl(link.configured ? link.baseUrl : "");
    setMode(link.configured ? link.mode : "external-hermes");
    setBearer("");
    setFormError(null);
    setEditing(true);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
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
    save.mutate();
  }

  const lines = [
    "에이전트가 사용할 provider를 이 서버 전체에 하나로 연결합니다.",
    "키는 이 서버에만 저장되고 응답으로 다시 내려오지 않습니다. 저장한 뒤에는 마지막 4자리만 보입니다.",
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
          </div>

          <KeyValueRows
            rows={[
              { key: "모드", value: choiceLabel(PROVIDER_MODES, link.mode) },
              { key: "저장된 키", value: maskedBearer(link.bearerLast4), numeric: true },
              { key: "가용성", value: availabilityLabel(link.availability) },
              ...(link.updatedAtMs
                ? [
                    {
                      key: "마지막 저장",
                      value: new Date(link.updatedAtMs).toLocaleString("ko-KR"),
                      numeric: true,
                    },
                  ]
                : []),
            ]}
          />

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
          <Field
            label="provider 주소"
            htmlFor="provider-base-url"
            hint="예: https://api.example.com/v1"
          >
            <Input
              id="provider-base-url"
              name="baseUrl"
              value={baseUrl}
              autoComplete="off"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </Field>

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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setFormError(null);
              }}
            >
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
              question="저장된 주소와 키를 지웁니다."
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
          that sentence stays exactly as it was. */}
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
