# 01 — 방법론 Ground Truth (Founder Solutions 도메인 적응판)

> 출처 방법론: `~/.claude/skills/startup-ideation-funnel/SKILL.md` (유니콘 아이디어 발굴 7단계 퍼널)
> 도메인 근거: `../모두의창업_창업가수요_리서치.md` (한국 vs 해외 초기 founder 수요 격차)
> 작성 기준일: 2026-06-23

## 타겟 도메인
초기 단계(예비~3년차) **창업가(founder)를 위한 솔루션/MVP**. 양면시장(VC×Startup)이 아니라 **founder 단일 사용자**가 1차 고객이다.

## 4대 원칙 (전 단계 공통)
1. **점진적 특정성** — 02는 01을, 03은 02를, …07은 06을 직접 인용. 새 컨셉 임의 도입 금지.
2. **정량 평가 우선** — Hotness 7-dim, MVP 8-axis 가중 rubric. 점수 없는 추천 금지.
3. **출처 의무** — funding/ARR/시장규모/hotness 정량 주장은 인라인 `[출처: url, accessed 2026-06-XX]`. 추정은 `[출처: estimate, based on …]`.
4. **양극 페인 매핑 (도메인 적응)** — 기본 스킬의 `VC pain ↔ Startup pain`을 본 도메인에서는 **`🇰🇷 국내 founder pain ↔ 🌐 해외 founder pain`**으로 치환한다. 교집합(공통 페인)은 `⚖️`로 별도 마킹. **격차가 곧 기회**이므로, 한쪽에만 존재하는 화이트스페이스(특히 🇰🇷 공백)를 우선 발굴한다.

## 도메인 수요 격차 (02~07이 인용할 ground truth)
직전 리서치에서 확정된 핵심 격차:
- **공통 1순위 페인 = 자금조달** (한국 자금확보 71% / 글로벌 Slush 58~63%). → 한국 특수성 아님.
- **갈리는 2순위**: 🇰🇷 **개발자 채용난(64%) = '만들 사람' 부재** vs 🌐 **distribution(고객확보) = '알릴 방법' 부재**.
- **빌드 비용 붕괴**(바이브코딩·AI SDK)로 글로벌 병목은 이미 build→distribution으로 이동. 한국도 곧 도래.
- 🌐 디폴트: Stripe Atlas 글로벌 결제·법인(169개국), AI 에이전트 빌드(Atlas 44%), 부트스트랩·PLG(60%).
- 🌐 1차 신호(인디해커): 1순위 불만은 돈·기술이 아니라 **동료 피드백·책임·번아웃·외로움**.
- 정책: 모두의 창업류 **정부 바우처의 공급≠수요 미스매치**(실제 선택 데이터 미공개) + 공급망형 데이터 유출로 인한 **신뢰 붕괴**.

## 7단계 퍼널 & 게이트
- 02 섹션 분류 → 03 발산(60~120) → 04 Hotness(≥65 컷, ~30개) → 05 경쟁 landscape(~15-18) → 06 MVP shortlist(≥85 컷, ~10) → 07 deep-dive(10 files).
- 각 단계 종료 시: ① md 경로 ② 객관 gate-check ③ 3줄 요약 ④ 사용자 컨펌 후 진행.

## Rubric 정의 (참조용)
- **Hotness(0~100)**: Google Trends 10 / Funding velocity 25 / ProductHunt 10 / GitHub star 10 / 채용공고 15 / Social 10 / VC thesis fit 20.
- **MVP(0~100)**: Market size 15 / Pain severity 20 / Founder-Market Fit 10 / 10x rule 15 / Timing 10 / Moat 10 / 8주 feasibility 10 / Korea+global potential 10.
