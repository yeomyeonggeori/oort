# LIVE-4 우로보로스 인터뷰 산출 — 로그인 핸드오프 편성 + LIVE-5 예약 스코프

> 2026-08-16 Fable. 성재 지시("다음 작업을 우로보로스 인터뷰로 상세 디벨롭 → 승인") 집행분.
> 인터뷰 세션 `interview_20260815_174057`(모호도 0.17 종결) + lateral 3렌즈(researcher/contrarian/simplifier). **성재 결재(2026-08-16 구조화 질의): LIVE-4 승인+발사 · LIVE-5 예약 확정.**
> 경계 정본: ADR-0004 증보 3(Accepted) · ADR-0165+증보 1(Accepted). 선행: LIVE-3(`460f142b`)·#1425(동결 affbc193 — 랜딩이 LIVE-4 base 조건).

## §1. 확정 설계 6개 (인터뷰 라운드별)

1. **발화 표면 = 이원**: 채팅 구조화 카드(정본 발화 — 승인 카드 가족 신구성원·알림/미읽음/폰 도달·세션 딥링크 앵커) + 세션 상세 상태 표시. 근거: 에이전트=member 불변식·단일 쓰기경로. 폰은 카드 표시+["데스크톱/웹에서 열기"] 안내(attach 내부 비반입 가드 유지).
2. **반환 = 명시 버튼 주동선**("직접 조작 마치기" 계열 — 카피는 design-review 확정). lease lapse(90초)는 안전망(연결 유실·탭 닫힘 — 오류 톤 금지). 서버 의미론이 강제: 활성 뷰어는 lapse하지 않는다.
3. **에이전트 신호 3분기**(end_reason이 이미 구분): `returned`=「사용자 개입 완료」(로그인 됐다는 전제로 재개) / `expired`=「중단·완료 불확실」(재개하되 자기 화면에서 상태 재확인 후 진행 — 완료 가정 금지) / `session_ended`. 카드 터미널 상태 3종이 이에 대응.
4. **스코프 절단 = 발제자(initiator) 기준** (lateral 최대 수확): LIVE-4 = **에이전트 발제형 로그인 핸드오프만**. 정지는 에이전트 자신의 요청이라 pre-TURN에도 무해하고 카드 실동작(재개/중단)이 오늘 성립. 사용자 발제형 "직접 조작 시작"·입력 포워딩·창 열기 UX = 전부 LIVE-5. 프레임 게이팅안(framesDecoded>0 어포던스 활성화)은 **기각** — contrarian: 클라 측정치로 서버 부수효과를 지키는 TOCTOU, ADR-0165 D4 자기 위반·D2 직결 계약상 서버 승격 영구 불가("안전 극장"). simplifier: "상호작용을 게이트하지 말고 존재를 게이트하라 — 영원히 비활성인 버튼은 UI 차용증."
5. **관전자 자격 노출 매듭**(인터뷰 적발 — Q3, 이후 정정): control 중 팀원이 소유자의 2FA·계정명 화면을 봄. 마스킹=서버 비경유라 원천 불가. 1차 답(신규 observer-validate 거부 절+ADR 소증보)은 **철회** — researcher 실측 근거로 **기존 observation→owner_only 전환+반환 시 복원 재사용**이 우월(신규 표면 0·LIVE-2 revocation-도달 기계가 관전자를 끊음·LIVE-3 owner 예외로 소유자는 계속 봄·D3 "observation 모델 그대로" 문장도 참 유지 = ADR 증보 불요). LIVE-5 편입(창을 여는 쪽 플로우).
6. **정직 카피 2분법**: 배포 사실("이 배포에서는 아직 화면 전송이 준비되지 않았습니다" — 운영자 영역) ≠ 세션 사실("연결 안 됨" — 재시도 유도). 영구 회색이 사용자-수리-가능처럼 읽히는 것 방지.

## §2. lateral 판정 기록 (정정 포함)

- contrarian "control 창에 TTL·heartbeat 없음(고아 창=영구 정지)" 주장은 **코드와 어긋남** — LIVE-3의 창 자체 lease 90초+lapse sweep+#1425 notifier sweep이 정확히 그 auto-revert(오케스트레이터 재판정). 원리(안전=진입 차단이 아니라 탈출 유계)는 채택, 사실은 정정.
- researcher 3조건 처분: ①LIVE-4는 #1425 랜딩 뒤 base — **채택**(발사 조건) ②실패 경로 auto-return(협상 30s<lease 90s) — **LIVE-5 AC 1번으로 이월**(LIVE-4는 창을 열지 않으므로 해당 경로 부재) ③관전자 공존 결정 — §1-5로 채택.
- #1425 이탈 1(파킹 run의 거절 문장 분화 `agent run is not eligible…`)은 에이전트-facing이라 LIVE-4 UX 비접촉 — 기록만.

## §3. LIVE-5 예약 스코프 (성재 확정 2026-08-16 — TURN 발주 후 패킷화)

창 열기 UX(카드/세션 표면 발제·라이브 링크 전제) · **observation 전환/복원**(control 시작 시 owner_only 강제+반환 시 자동 복원=기본안, 카피로 고지) · **실패 auto-return**(controller 협상 timeout 30s 내 명시 반환 REST — AC 1번, 해악 지속시간을 "테스트된 숫자"로) · 입력 포워딩(datachannel — view-only엔 채널 부재 유지) · ICE 결선(`DISPLAY_ICE_SERVERS=[]` 해소·relay 강제) · 실 E2E(TURN+실기동 라벨 3종 해소) · **세션 표면 control 상태의 내구 투영**(LIVE-4 동결 경계 이월 — 3투영 드리프트 가드 vs bare RETURNING의 SoT 결정 포함, 그 전까지 세션 상세는 라이브 이벤트만 그림).

## §4. LIVE-4 수용기준 골자 (패킷이 정본화)

카드 가족: 코어 계약+웹 렌더+에이전트 방출 계약 — **기존 승인 hold(is_approval_held) 기계 재사용 1순위 탐사**(#1425가 그 의미 보존을 테스트로 고정, 성립 불가 판명 시 동결+보고) · 카드 터미널 3종=end_reason 대응 · 경계 이벤트(work.session.control — API로 창이 열린 경우 포함) 카드·세션 표면 정직 표시 · displayStream 부재-단언(인수 금지·datachannel 부재·input_enabled 정직)의 controller 시대 갱신 · 정직 카피 2분법 · design-review Blocker 0.
