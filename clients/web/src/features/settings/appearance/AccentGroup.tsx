import { useLayoutEffect, useMemo, useRef } from "react";
import { Check } from "lucide-react";
import { effectiveScheme, modesOf } from "@momo/core/design/themeResolve";
import {
  ACCENT_THEMES,
  setAccent,
  useAccentId,
  useAppearance,
  useSystemScheme,
  type AccentId,
} from "@/design/theme";
import { defaultSignalFor, presetsFor } from "@/design/themes/derived";
import { paintElement } from "@/design/themes/paint";
import { cn } from "@/design/lib/cn";

// =============================================================================
// 강조색 칩 한 벌: 이 테마·모드에서 푼 색과 쓸 수 있는지 (AP-1b #4188, AC 6). **지연 청크**다.
//
// 칩의 색은 예전에 새벽하늘 값에 묶인 정적 바인딩(`themes/<id>.css`의 `[data-accent-swatch]`)이 줬다. 테마를 고를
// 수 있게 된 지금 그 색은 거짓이 된다: 흑연에서 홍염을 누르면 흑연의 신호 규칙으로 보정된 색이 서는데 칩은
// 새벽하늘의 색이다. 그래서 **그 테마·모드에서 푼 색**을 칩에 꽂는다(첫 파티는 core 표, 카탈로그는 파생 엔진).
// 그 산수(`resolveSignal`)가 메인 번들에 들어가지 않도록 이 청크에서 푼다. 청크를 받는 동안(또는 받지 못했을
// 때)에는 `ThemeCard`가 기존 모양의 정적 칩을 보인다.
//
// 카탈로그에서는 프리셋이 거절될 수 있다(홍염은 57 테마-모드 가운데 29곳에서 위험색과 겹친다. core `derive.test.ts`의
// 「프리셋 거절 통계」가 세고, 테마 토큰 표 §8.5의 프로토타입 값 26과는 구현 실측이 다르다). 거절된 칩은 눌 수 없고
// 이유(core `SIGNAL_REJECTION_COPY` 한 줄)가 칩 아래에 선다. 모드는 지금 화면에 서 있는 모드다: 고정이면 그 모드,
// 시스템이면 이 기기의 시스템이 지금 어느 쪽인가.
// =============================================================================

interface Chip {
  /** 칩이 보일 색. `null`이면 거절돼서 색을 칠하지 않는다. */
  readonly paint: { readonly signal: string; readonly onSignal: string } | null;
  /** 거절된 이유 한 줄. 서는 칩은 `null`. */
  readonly reason: string | null;
}

type Chips = Readonly<Record<AccentId, Chip>>;

function useChips(): Chips | null {
  const { theme, scheme } = useAppearance();
  const system = useSystemScheme();
  const mode = effectiveScheme(scheme, modesOf(theme)) ?? system;
  return useMemo(() => {
    const presets = presetsFor(theme, mode);
    const fallback = defaultSignalFor(theme, mode);
    if (!presets || !fallback) return null;
    const chips = { dawn: { paint: fallback, reason: null } } as Record<AccentId, Chip>;
    for (const [id, outcome] of Object.entries(presets)) {
      chips[id as AccentId] = outcome.ok
        ? { paint: { signal: outcome.signal, onSignal: outcome.onSignal }, reason: null }
        : { paint: null, reason: outcome.message };
    }
    return chips;
  }, [theme, mode]);
}

const REASON_ID = "appearance-accent-unavailable";
/** 저장된 선택이 이 테마·모드에서 거절돼 화면이 기본 신호로 서 있을 때 이유 줄 끝에 붙는 한 문장(폰도 같은 말을 한다). */
const STORED_REJECTED_COPY = "고른 강조색은 이 테마에서 쓸 수 없어 기본 색으로 보여요.";

/** 같은 이유로 거절된 칩은 한 줄로 묶는다(「성운·홍염: …」). 같은 문장을 칩마다 되풀이하지 않는다. */
function reasonText(unavailable: readonly { id: AccentId; label: string }[], chips: Chips | null): string {
  const groups = new Map<string, string[]>();
  for (const theme of unavailable) {
    const reason = chips?.[theme.id]?.reason ?? "";
    groups.set(reason, [...(groups.get(reason) ?? []), theme.label]);
  }
  return [...groups].map(([reason, labels]) => `${labels.join("·")}: ${reason}`).join(" ");
}

function Swatch({ id, label, checked, chip }: { id: AccentId; label: string; checked: boolean; chip: Chip | undefined }) {
  const node = useRef<HTMLLabelElement>(null);
  const paint = chip?.paint ?? null;
  useLayoutEffect(() => {
    const chipNode = node.current;
    if (!chipNode) return;
    if (paint) {
      paintElement(chipNode, { "--signal": paint.signal, "--on-signal": paint.onSignal });
    } else {
      // 거절된 칩은 색을 칠하지 않는다. 서 있던 칩이 테마를 바꿔 거절되면 앞 테마가 꽂은 값을 걷어서, 흐린 칩이 늘
      // 정적 바인딩(새벽하늘 값)으로 보이게 한다(남겨 두면 어느 테마를 거쳐 왔는지에 따라 흐린 색이 달라진다).
      chipNode.style.removeProperty("--signal");
      chipNode.style.removeProperty("--on-signal");
    }
  }, [paint]);
  const disabled = chip?.reason != null;
  return (
    <label
      ref={node}
      data-accent-swatch={id}
      data-testid={`accent-swatch-${id}`}
      aria-disabled={disabled ? "true" : undefined}
      className="accent-swatch flex cursor-pointer flex-col items-center justify-center gap-1 text-meta text-ink press"
    >
      <input
        type="radio"
        name="appearance-accent"
        value={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={disabled ? REASON_ID : undefined}
        onChange={() => setAccent(id)}
        className="sr-only"
      />
      <span className="accent-swatch-chip flex items-center justify-center rounded-full" aria-hidden>
        <Check className={cn("accent-swatch-check size-4")} aria-hidden />
      </span>
      {label}
    </label>
  );
}

export default function AccentGroup({ isDawnsky }: { isDawnsky: boolean }) {
  const accent = useAccentId();
  const chips = useChips();
  // 고른 프리셋이 이 테마·모드에서 못 쓰는 것이면 화면은 이미 테마의 기본 신호로 서 있으므로 「기본」 칩을 고른
  // 것으로 보인다(저장된 선택은 그대로라 쓸 수 있는 테마로 돌아가면 다시 선다).
  const unavailable = ACCENT_THEMES.filter((theme) => chips?.[theme.id]?.reason != null);
  const storedRejected = chips?.[accent]?.reason != null;
  const shown: AccentId = storedRejected ? "dawn" : accent;
  return (
    <fieldset data-testid="accent-choice" className="m-0 min-w-0 border-0 p-0">
      <legend className="sr-only">강조색</legend>
      <div className="flex flex-wrap gap-4">
        {ACCENT_THEMES.map((theme) => (
          <Swatch
            key={theme.id}
            id={theme.id}
            label={theme.id === ACCENT_THEMES[0].id && !isDawnsky ? "기본" : theme.label}
            checked={shown === theme.id}
            chip={chips?.[theme.id]}
          />
        ))}
      </div>
      {unavailable.length > 0 ? (
        <p id={REASON_ID} data-testid="accent-unavailable" className="mt-2 break-keep text-meta text-ink-muted">
          {reasonText(unavailable, chips)}
          {storedRejected ? ` ${STORED_REJECTED_COPY}` : ""}
        </p>
      ) : null}
    </fieldset>
  );
}
