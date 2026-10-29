import { useEffect, useRef, useState } from "react";
import type { FilterTabsSpec } from "@momo/core/features/common/filterTabs";
import { formatDay } from "@momo/core/features/settings/model";
import type { CreatedDevCredential, DevTool } from "@momo/core/features/auth/devAccess";
import {
  commandTabsFor,
  DEV_COMMANDS_UNAVAILABLE_TEXT,
  DEV_ONE_TIME_COPY,
  DEV_TOOL_CHOICES,
  devExpiry,
  devScopeDetail,
  devScopeKind,
  devScopeLabel,
  devToolLabel,
  type DevCommandOption,
  type DevCommandStep,
} from "@momo/core/features/auth/devAccessModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { FilterTabs } from "@/features/common/FilterTabs";
import { OneTimeSecretCard } from "@/features/hostedAgents/OneTimeSecretCard";
import { holdGlobalShortcuts } from "@/app/globalShortcutHold";
import { absoluteApiBase } from "@/lib/serverBase";
import { CopyButton, KeyValueRows } from "./SettingsFields";

// Reading this as: settings for internal team users on web+Tauri,
// density 6/10, motion 2/10.

// =============================================================================
// 한 번만 보이는 화면 (#4663, ADR-0216 D6, ADR-0162 D6 선례). 새 연결 값이 화면에 서는 유일한
// 순간이고, 서버는 해시만 보관하므로 이 값을 다시 만들 수 없다.
//
// **다이얼로그인 이유**: 인라인 카드는 Esc는 막아도 설정 목차를 눌러 다른 페이지로 가는 길을 못
// 막는다(목차 이동은 이 섹션을 언마운트하고, 값은 말 없이 사라진다). 모달은 뒤 페이지를 비활성으로
// 만들고 초점을 안에 가둔다. Esc와 바깥 클릭은 값이 떠 있는 동안 막는다: Radix는 층 스택에 들어오지
// 않으므로 `useEscapeGuard`가 아니라 `onEscapeKeyDown`·`onInteractOutside`가 그 자리다
// (`HostedAgentWizard`와 같다). 설정 셸의 Esc 캡처는 열린 다이얼로그를 보고 물러난다
// (`escapeIsClaimed`).
//
// **초점도 안에 가둔다.** Radix의 가둠(`FocusScope`)은 「마지막으로 초점이 있던 곳」을 알아야 초점이 밖으로
// 새도 되돌리는데, 그 기억은 가둠 귀가 달린 **뒤에** 안에서 초점이 움직여야 채워진다. 값 카드는 마운트 때
// 스스로 초점을 가져가서(그 귀가 달리기 전이다) 기억이 비어 있고, 실브라우저에서 이런 길이 샜다: 바깥을
// 눌러 초점이 body로 떨어짐 → Tab이 뒤의 설정 목차로 감 → Enter 한 번에 섹션이 바뀌고 값이 말없이 사라짐.
// 그래서 초점이 다이얼로그 밖에 닿으면 값 카드로 되돌리는 일을 여기서 직접 한다(`pullBack`).
//
// 나가는 길은 이름으로 하나뿐이다: 「저장했어요」. 값은 `OneTimeSecretCard`가 보이고, 이 파일은 값을
// 자기 상태·저장소·로그에 옮기지 않는다(받은 `created`를 그대로 카드에 건넬 뿐이다).
//
// 아래 「도구에 넣는 방법」에는 값이 없다. 값은 환경 변수 `OORT_TOKEN`에 **입력으로** 넣고, 설정
// 조각은 그 변수를 가리킬 뿐이다(코어 `commandTabsFor`). 값이 든 명령줄·헤더 한 줄은 어디에도
// 만들지 않는다: 프로세스 목록과 셸 기록에 값이 남는다(ADR-0190 D3-h).
// =============================================================================

const COMMAND_TABS: FilterTabsSpec<DevTool> = {
  label: "도구별 연결 방법",
  values: DEV_TOOL_CHOICES,
  labelFor: devToolLabel,
  tabId: (tool) => `dev-command-tab-${tool}`,
  panelId: (tool) => `dev-command-panel-${tool}`,
  testId: (tool) => `dev-command-tab-${tool}`,
};

/** 만든 사람이 고른 도구의 탭에서 시작한다. 고르지 않는 값(기타)이면 직접 명령이다. */
function initialTool(tool: DevTool): DevTool {
  return DEV_TOOL_CHOICES.includes(tool) ? tool : "cli";
}

export function DevAccessReveal({
  created,
  workspaceId,
  opener,
  onDone,
}: {
  created: CreatedDevCredential;
  workspaceId: string;
  /** 닫힐 때 초점을 돌려줄 곳(「연결 만들기」 버튼). */
  opener: DialogFocusTarget | null;
  onDone: () => void;
}) {
  const [tool, setTool] = useState<DevTool>(() => initialTool(created.tool));
  const contentRef = useRef<HTMLDivElement | null>(null);
  const options = commandTabsFor(tool, {
    serverOrigin: absoluteApiBase(),
    workspaceId,
  });

  // 값이 떠 있는 동안 창의 이동 단축키(⌘⇧A·⌘K·⌘⇧K·⌥↑↓)를 멈춘다: 모달은 창의 keydown 을 막지 않아서, 키 한 번이
  // 설정 라우트를 내리고 다시 볼 수 없는 값이 사라졌다(`globalShortcutHold`). 풀리는 때는 이 화면이 사라질 때다.
  useEffect(() => holdGlobalShortcuts(), []);

  useEffect(() => {
    function pullBack(event: FocusEvent) {
      const content = contentRef.current;
      const target = event.target;
      if (content === null || !(target instanceof Node) || content.contains(target)) return;
      content
        .querySelector<HTMLElement>('[data-testid="dev-access-secret"]')
        ?.focus({ preventScroll: true });
    }
    document.addEventListener("focusin", pullBack);
    return () => document.removeEventListener("focusin", pullBack);
  }, []);

  const restricted = created.channelIds !== undefined;
  const expiry = devExpiry(created.expiresAtMs, Date.now());
  const scope =
    devScopeKind(created.scopes) === "custom"
      ? `${devScopeLabel(created.scopes, restricted)} (${devScopeDetail(created.scopes)})`
      : devScopeLabel(created.scopes, restricted);

  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent
        ref={contentRef}
        opener={opener}
        onEscapeKeyDown={(event) => {
          // 다시 만들 수 없는 값 앞에서 Esc의 올바른 뜻은 무반응이다.
          event.preventDefault();
        }}
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
        data-testid="dev-access-reveal"
      >
        <div className="flex min-w-0 flex-col gap-1 border-b border-line p-4">
          <DialogTitle>연결을 만들었어요</DialogTitle>
          <DialogDescription className="break-keep">
            방금 만든 연결의 값이에요. 도구에 넣는 방법도 아래에 있어요.
          </DialogDescription>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
          <KeyValueRows
            rows={[
              {
                key: "이름",
                value: <span className="break-words">{created.name}</span>,
                prose: true,
              },
              { key: "쓰는 도구", value: devToolLabel(created.tool), prose: true },
              { key: "범위", value: scope, prose: true },
              {
                key: "만료",
                value: `${expiry.label} (${formatDay(created.expiresAtMs)})`,
                prose: true,
              },
            ]}
          />

          <OneTimeSecretCard
            headline="연결 값"
            warning={DEV_ONE_TIME_COPY.warning}
            notes={[DEV_ONE_TIME_COPY.caution]}
            secretLabel="연결 값"
            secret={created.token}
            copyLabel="복사"
            onDone={onDone}
            doneLabel={DEV_ONE_TIME_COPY.confirmLabel}
            testId="dev-access-secret"
          />

          <section
            className="flex min-w-0 flex-col gap-3"
            aria-labelledby="dev-command-heading"
            data-testid="dev-access-commands"
          >
            <h3 id="dev-command-heading" className="text-body font-semibold text-ink">
              도구에 넣는 방법
            </h3>
            <FilterTabs spec={COMMAND_TABS} value={tool} onChange={setTool} />
            <div
              role="tabpanel"
              id={COMMAND_TABS.panelId(tool)}
              aria-labelledby={COMMAND_TABS.tabId(tool)}
              className="flex min-w-0 flex-col gap-4"
              data-testid="dev-command-panel"
              data-tool={tool}
            >
              {options.length === 0 ? (
                <p className="break-keep text-body text-ink-muted" data-testid="dev-command-unavailable">
                  {DEV_COMMANDS_UNAVAILABLE_TEXT}
                </p>
              ) : (
                options.map((option) => <CommandOption key={option.id} option={option} />)
              )}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CommandOption({ option }: { option: DevCommandOption }) {
  let codeIndex = 0;
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-testid={`dev-command-option-${option.id}`}
    >
      <p className="break-keep text-body font-medium text-ink">{option.title}</p>
      {option.steps.map((step, index) => {
        if (step.kind === "prose") {
          return (
            <p key={index} className="break-keep text-body text-ink-muted">
              {step.text}
            </p>
          );
        }
        codeIndex += 1;
        return (
          <CodeStep key={index} step={step} subject={`${step.label ?? "명령"} ${codeIndex}`} />
        );
      })}
    </div>
  );
}

/**
 * 복사할 수 있는 코드 조각 하나. 값이 없는 조각이다(코어가 보장한다). 긴 줄은 접어서 명령 전체가
 * 보이게 한다(가로 스크롤은 뒤쪽 `| curl …`이 안 보여 값이 어디로 가는지 읽히지 않는다). 복사는
 * 접힌 모양이 아니라 원문이다. 세로로 넘치면 상자 안에서 스크롤하고, 그 상자는 키보드가 닿도록 초점을
 * 받는다.
 */
function CodeStep({ step, subject }: { step: DevCommandStep; subject: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="dev-command-code">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 break-keep text-meta text-ink-muted">{step.label ?? "명령"}</p>
        <CopyButton value={step.text} label="복사" subject={subject} />
      </div>
      <pre
        tabIndex={0}
        className="max-h-pane overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-hover p-3 font-mono text-code text-ink focus-visible:focus-ring"
      >
        {step.text}
      </pre>
    </div>
  );
}
