# 코메토 플랫 표정 6종 — 규격 시트 (#2806, ADR-0193 D9·D11)

> 작성 중. 경로·파일명·id는 확정이다(#2807 OB2-1이 이 계약을 쓴다).

## 경로 계약

| 무엇 | 경로 | 규격 |
|---|---|---|
| 원본(생성·합성 결과) | `docs/brand/kometto/faces/kometto-{id}-{theme}.png` | 1254×1254, 불투명 RGB. K6 플랫 원본과 같은 캔버스 |
| 웹 에셋(파이프라인 파생) | `clients/web/src/assets/brand/kometto-faces/{id}-{theme}.png` | 576×576 RGBA, 배지 원 밖 투명, sRGB. `kometto-badge.png`와 같은 크롭 |

- `id`: `idle` · `thinking` · `happy` · `flustered` · `working` · `sleepy`
- `theme`: `dark`(남색 원, K6-flat-dark) · `light`(크림 원, K6-flat-light)
- 웹 에셋은 `clients/web/scripts/render-brand-icons.mjs`가 원본에서 떠내고 검사한다. 손으로 고치지 않는다.
