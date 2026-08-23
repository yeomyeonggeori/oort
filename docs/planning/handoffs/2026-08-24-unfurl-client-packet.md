# 언퍼얼 클라 렌더 패킷 (ADR-0170 집행 2/2)

> Status: `ready`(게이트=#1717 track/engine 랜딩) · Planner: Fable · Integrator: momo-main
> 트랙=uxui · 워커=sol · 검수=Fable+design-review. 서버 계약은 #1717의 openapi(+218줄)가 정본.

## 계약

1. **웹 타임라인 카드(D5)**: 메시지 아래 언퍼얼 카드(제목·설명·도메인·이미지) — 이미지는 서버 프록시 라우트만(원격 직결 금지 — CSP 불변). **4상태**: pending(자리 예약 또는 침묵 중 택일하되 근거 주석)·ok·failed/blocked(침묵 — 카드 미표시가 기본)·빈. outbox 이벤트(realtimeEvents)로 라이브 도착, 채널 재입장 시 REST 병합.
2. **메시지 단위 제거(x)**: 발신자 본인 메시지의 카드에만 제거 컨트롤(서버 REST 소비·재생성 없음 카피 명시). Esc 층·키보드 도달.
3. **개인 설정**: 설정 표면에 "링크 미리보기 접기"(내 화면 렌더만 끔 — 서버 fetch와 무관함을 카피가 구분). 워크스페이스 설정(관리자 on/off)은 기존 관리 표면 관례 위치에.
4. **폰**: 이번 스코프 밖(웹 먼저 — 파도 관례). ENGINE_HANDOFF에 폰 후속 행만.
5. 서버 계약 비접촉·momo-core에 타입/상태 기계(웹·폰 공유 대비) 배치.

## AC
- 카드 4상태 렌더 테스트+제거 왕복+설정 지속화. 오르트 구름 준수(토큰·무검사 목록 §5.3 유의), design_preflight_web 그린, design-review Blocker 0.
- 서버 off(인스턴스/워크스페이스) 시 카드 표면이 조용히 부재(빈 공간·플레이스홀더 금지).

## 함정
- 서버 기본 `MOMO_UNFURL_ENABLED=0` — 로컬 검증은 env 켜고 mock으로. worker는 PR(base=track/uxui) 후 정지·merge/close 금지.
