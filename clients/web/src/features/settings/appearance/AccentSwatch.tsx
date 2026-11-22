import type { Ref } from "react";
import { Check } from "lucide-react";
import type { AccentId } from "@/design/theme";
import { Tooltip } from "@/design/ui/tooltip";

// 강조색 칩 한 칸 (#5783 QA 8, Buzz `AccentPickerContent`처럼 이름 없는 동그라미 한 줄).
//
// 이름은 화면에서 뺐고 두 길로 남는다: 라디오의 접근 가능한 이름(라벨 안의 `sr-only` 글자)과, 가리키거나 키보드 초점일 때 뜨는
// 우리 `Tooltip`. 툴팁은 `aria-hidden`이라 이름을 두 번 읽히지 않는다(네이티브 `title`은 두지 않는다: 둘이 같이 뜬다).
// 고른 칩은 잉크 고리 + 체크가 말한다(색만으로 말하지 않는다). 쓸 수 없는 칩은 흐리고 누를 수 없으며, 이유는 칩 줄 아래의
// 한 줄이 말한다(`describedBy`): 비활성 라디오는 키보드 초점을 받지 못하고 터치는 툴팁을 띄우지 않아서, 툴팁만으로는 그 이유를
// 키보드·터치에서 알 수 없다. 라디오는 누르는 자리(44) 전체를 투명하게 덮는다(`radio-cover`): Tab으로 닿을 때 브라우저가 칩 전체를
// 창 안으로 데려온다(1×1 `sr-only`이면 윗변만 보고 멈춰 칩이 창 아래로 잘렸다). 칩 줄이 일부만 보일 때 방향키·누름으로 고르면 WebKit은
// 따라오지 않아(Chromium은 따라옴, 검수 r4 B-1d와 같은 엔진 차이) 고른 순간(change)에만 그 칩을 초점 링까지(라디오의 `scroll-margin`)
// 가장 가까운 자리로 데려온다. 초점·마운트에는 걸지 않는다(`ThemeTile`의 `followPick`과 같은 규칙).
//
// 지연 청크(`AccentGroup`)와 그 청크를 받는 동안의 정적 칩(`ThemeCard`의 `StaticAccentGroup`)이 이 부품 하나를 같이 써서, 청크가
// 도착해도 칩 줄의 크기와 자리가 한 픽셀도 달라지지 않는다. 모양은 `design/themes/swatches.css`.

export function AccentSwatch({
  id,
  label,
  checked,
  onSelect,
  disabled = false,
  describedBy,
  labelRef,
}: {
  id: AccentId;
  /** 칩의 이름(새벽하늘이 아닌 테마의 첫 칩은 「기본」). 화면에는 없고 낭독·툴팁에만 있다. */
  label: string;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  /** 쓸 수 없는 이유 줄의 id. */
  describedBy?: string;
  /** 지연 청크가 그 테마·모드에서 푼 색을 꽂는 자리. */
  labelRef?: Ref<HTMLLabelElement>;
}) {
  return (
    <Tooltip label={label}>
      <label
        ref={labelRef}
        data-accent-swatch={id}
        data-testid={`accent-swatch-${id}`}
        aria-disabled={disabled ? "true" : undefined}
        className="accent-swatch radio-cover flex cursor-pointer items-center justify-center press"
      >
        <input
          type="radio"
          name="appearance-accent"
          value={id}
          checked={checked}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => {
            onSelect();
            event.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" });
          }}
        />
        <span className="accent-swatch-chip flex items-center justify-center rounded-full" aria-hidden>
          <Check className="accent-swatch-check size-4" aria-hidden />
        </span>
        <span className="sr-only">{label}</span>
      </label>
    </Tooltip>
  );
}
