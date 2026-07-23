# 기획 세션 저널 (newest-first, 기존 항목 불변)

> 목적: **기획/오케스트레이션 세션 간 이어달리기.** Fable이든 GPT 5.6이든, 세션을 시작할 때 최근 항목을 읽고, 끝낼 때 항목을 추가한다(`docs/planning/README.md` §1).
> 규칙: 항목당 5줄 이내. 새 항목은 맨 위에 추가하고 기존 항목은 수정하지 않는다. 결정·증거·계획의 정본이 아니다(그건 ADR/STATUS/ROADMAP) — 여기는 "무엇을 하다 어디서 멈췄나"만. 최신이 위.

---

## 2026-07-23 (Fable Wave H 완결 — 562 랜딩·565 착수) · 관측 실물화 + 내부 알파 재배포
- **562 main 랜딩**(f5a6a55): /metrics 5종·bounded 라벨·프라이빗 전용·prometheus opt-in 오버레이(mem_limit/digest 핀 정합 후속 포함). verifier 4엔드포인트 실기동 PASS(28210s). **Linux 전용 결함 2건 검출·수정**: PushRelay 암묵 nio 전이 import, swift-crypto Sendable 격차(@preconcurrency) — 함정 목록 승격.
- **내부 알파 재배포 완결**: `scripts/internal_alpha_stack.sh`(redeploy/status/reclaim) 정본화 — 부분 수렴·restart 함정 2건 성문화, momowebqa가 신 태세(cancel/pause 실서빙, 데이터 보존)로 전환. 실 AWS는 내부 검증+UXUI 피드백 후(성재 확정).
- **Wave H 전량 완결**(554~563+558). 565(#681) worker 가동. 다음: 565 랜딩 → 리허설 Phase 1 → 564 → 공개.

## 2026-07-23 (momo-main 인수 — 패키징 레인 판정 확정) · 연구 §7 6건 전건 판정, 크리티컬 패스 재편
- 성재 위임("기각/수용 판단해 계획 포함")에 따라 §8 판정 확정: 옵션 A(이미지 6→1) **수용=MOMO-565**(562 후·리허설 전, ADR 불요 — ADR-0002 컨텍스트), 위생 ①② 수용(566·567, 패스 밖), code graph Phase 0~2 단계 수용, 모노레포 유지, mesh-llm 비편입(어댑터 확인은 즉석 실측 종결 — HERMES_BASE_URL=OpenAI-호환+루프백 해치, 신규 코드 0).
- 크리티컬 패스 재편: 562 → **565** → 리허설 Phase 1 → 564 → 공개. 옵션 C·멤버십 게이트 mesh는 백로그 예약(기안 금지).

## 2026-07-23 (Fable 리서치 — 패키징/레포 토폴로지/code graph) · 성재 발제 Q&A → 연구 문서 플러시
- 한 일: buzz 배포 실체 웹 검증(단일 '이미지'≠단일 컨테이너 — 앱 이미지 1+PG/Redis/MinIO compose 5~6컨테이너)·패키징 패턴 조사(Mattermost/Campfire/Discourse/Zulip/Supabase)·code graph 도구 실사(Swift 지원 기준 생존자 선별)·레포 무게 실측(무거움의 실체=SPM .build 15GB, tracked는 213K LOC로 작음)·mesh-llm 검증(Block 공식 아님·buzz 릴리스 동봉은 사실 — 코드 레벨 확인). 정본: `2026-07-23-packaging-repo-codegraph-research.md`.
- 판정 제안: ①커스텀 이미지 6→1 멀티바이너리 통합(buzz 동형, H3 후속 티켓 후보 — 권고) ②Centrifugo 제거 2서비스 수렴은 비권고 ③모노레포 유지(ADR-0001 트리거 미충족) + 위생 3종 후보 ④code graph는 저비용 3종+codebase-memory-mcp 실험만(Phase 0~2) ⑤mesh-llm 비편입·관찰(어댑터 OpenAI-호환 백엔드 확인만 소형 후속).
- 다음: 성재 결정 대기 6건(연구 문서 §7). 티켓/정본 반영 없음. Wave H 기존 큐와 독립.

## 2026-07-23 (Fable Wave H 집행 2 — 558·561 랜딩) · H2 완결 + H3 첫 타
- **main 랜딩 2장**: 561(migrate `set-owner` one-shot — env-only·재실행=회전+세션 revoke, verifier PASS 28200. "5분 설치 마지막 5분 DBA" 해소) / 558(Stop/Pause 클라 표면 — cancelRun TODO 해소·⌘.·시스템 라인 2종, macOS 522 tests 0실패). **ADR-0132 전 결정(D1~D5) 서버+클라 완결.**
- 558 design-review(신선 컨텍스트): Blocker 0·High 3 → 오케스트레이터 직접 해소: ①⌘. 취소 타겟 스트리밍 최근성 결정화 ②취소 시스템 라인 행위자 표기 ③스냅샷 렌더 NSHostingView 교체(실컨트롤 픽셀 포함 재기록). Medium 3(토글 라벨·에러 토큰 통일·응답 검증 완화)도 반영.
- 수리 2건 추가: 648 잠복 회귀(migrate 이미지에 중복번호 검사 스크립트 미동봉 — 컨테이너 127, 561 verifier가 검출) 핫픽스 / WorkConsole 터미널 프리셋 스냅샷 2장 선재 드리프트 재기록.
- 남은 Wave H: 560(653)·563(655) 발급 대기(성재 브리핑 후), 562=ADR-0121 증보 승인 대기, 564=공개 전제. 다음 큰 단계: **리허설 Phase 1**.

## 2026-07-23 (Fable Wave H 집행 — H1 완결+H2 서버 랜딩) · 554 Critical 해소, ADR-0132 Accepted 집행
- **main 랜딩 5장**: 554(prod RLS 실집행 — 롤 4분리+부트 가드+웹훅 키 분리, verifier 3회차 PASS 28170s)·555(게이트 하드닝 3종)·556(SPM 라이선스 게이트+dependabot, 실검사 37deps/9roots PASS)·557(휴먼 취소 REST+pause, verifier 5/5 PASS 28184s — worker 취소 경계 실왕복 확증)·559(depth 전파+G2+D4 프리앰블, verifier PASS 28191s). 이슈 647~650·652 close.
- **오케스트레이터 수리 6건**: .env.example 옛 태세 회귀 핫픽스(554 누락분 — 648 새 게이트가 검출), 650 migration 037→038 재부여(555 중복검사 실증), 취소 폴링 1s 스로틀(델타당 쿼리 결함), 557 verifier 3건(worker 소스빌드 기동 대기·run_id 대문자 조인·진단 덤프), 554 verifier preflight 정합, ENGINE_HANDOFF U″ ID 충돌 A-21/22/23 재부여.
- ADR-0121 **증보 1 기안(Proposed)** — /metrics 노출 계약(D7~D10, 562 게이트). 패킷 승격: handoffs/2026-07-22-buzz-hardening-batch.md(발급 후 델타 5건).
- 진행 중: 651(558 Stop/Pause UI, base track/uxui)·654(561 set-owner) worker 병렬. 다음: 654 랜딩→560→563, 651 랜딩(design-review), 이후 **리허설 Phase 1**(새 롤 태세 검증=공개 게이트). 성재 확인 대기: 내부 알파 재배포 여부(554 랜딩 조건), 557 run↔work_session 경계 해석, ADR-0121 증보 승인(→562).

## 2026-07-23 새벽 (Fable buzz→Wave H 기획) · PLN-20260722-02 plan-ready — 정본 2026-07-22-buzz-actions-plan.md + ADR-0132 Proposed
- 성재 지시("제안 액션 고도화+인프라 도입 검토+셀프호스팅 비교+우선순위·배포 판단+프롬프트")로 2차 사실 감사 2건 완료: ①momo RLS/게이트 태세 실코드 감사 — **Critical: prod 템플릿 API 롤=수퍼유저 momo(RLS 무효)**, 휴먼 정지권 REST 부재+cancelRun TODO, depth 전파 미구현, 게이트 3갭(skew/중복번호/SPM) ②셀프호스팅 축별 비교 — momo 우위(백업/롤백/BM), buzz 우위(단일이미지/owner 1줄/day-2 CLI/관측/공개 릴리스).
- 산출: Wave H 3단(H1 554~556 태세·게이트 / H2 ADR-0132 정지권·루프·발화계약 / H3 560~563 셀프호스팅 제품화)+Wave U″ 제안, worker 프롬프트 3종+오케스트레이터 인수 프롬프트 포함. ADR-0132 Proposed 기안.
- 독립 critic 검수 완료(신선 컨텍스트, 실코드 스팟체크) — 핵심 사실 전부 재확증, 정정 5건 반영(553 랜딩 반영·554 수리면 축소·555/556 순차화·D1 human 한정·562 ADR 증보 선행). §5에 기록.
- 다음: 성재 승인 3건 대기 — (a) H1 발급(기존 위임 큐 '게이트 부채 배치'와 합류 권장, 554는 리허설 Phase1 선행) (b) ADR-0132 option (c) H3 실행+공개 이미지 결정. 티켓/이슈 발급 없음(번호 554~563 예약만).

## 2026-07-22 (Fable buzz 경쟁 분석) · block/buzz 4축 해부 — 정본 2026-07-22-buzz-competitive-analysis.md
- 성재 발제: 어제(7/21) 공식 런칭한 block/buzz(Nostr relay 기반 agent-native 워크스페이스, HN 316pt) 0-tier 해부. 레포 전체 clone+병렬 4축(아키텍처/git 고고학/커뮤니티/UX) 분석 완료.
- 판정: momo와 동일 신념(에이전트=1급 멤버·PG=SoT·키 비유입)의 거울상. 프로토콜은 momo 우위(seq/outbox/RLS를 buzz는 구조적으로 못 가짐), 가져갈 것은 로직 계층(오너 위임 캐스케이드·페이지 계약·wake-only 푸시·승인 체인)+상흔(에이전트 멘션 루프·킬스위치 미도달·RLS 공리 5·branch-skew 가드).
- 커뮤니티 최대 쟁점=멀티 에이전트 권한 누출 질문에 buzz가 답 못함 — momo RLS FORCE+member 모델이 구조적 답(포지셔닝 전면 배치 제안).
- 제안 액션 7건(§8, 전부 성재 결정 대기): RLS 공리 게이트·라이선스 게이트·branch-skew·에이전트 상호작용 안전 계약·UXUI Top5·포지셔닝·4~6주 후 재방문. 티켓/정본 반영 없음.

## 2026-07-22 (Fable ⑮ 랜딩·공개 게이트 확정) · Memory Plane 사용자 표면 완결 + 법무 5항 확정
- **#646 MOMO-553 grant UI 랜딩(main c8bca25)** — design-review PASS(Blocker 0·High 0). 529의 X-11 잠금 완전 해제: Memory Plane이 추출→검색→packet→모델 주입→브라우저/인스펙터→**grant 부여/회수 UI**까지 전 표면 완결. 3 브랜치 동기, worker 0 — 계획 파이프라인 소진.
- **공개 게이트 5항 성재 확정**(외부 법무 없이 내부 확정): dawnkim·DCO(CONTRIBUTING.md 구현)·momo 유지(상표 미등록 리스크 고지)·Centrifugo v6 Apache-2.0 실측·NOTICE 유지 절차. 실배포 리허설 2단계 일정 확정(Phase1 로컬=게이트 부채 후, Phase2=성재 VPS 요청 시점 명시).
- 다음: 게이트 부채 배치 → 리허설 Phase 1 → ADR-0117 기안. 후속 소형: 553 Medium(피커 암묵 대상·⌘⇧G), 546 승인 이력 다건.

## 2026-07-22 (Fable UXUI 소비 3장 랜딩 + 통합 사고 수습) · ⑫⑬⑭ main, 마커 사고 2건 해소·절차화
- **랜딩→main(db47f52)**: #643 MOMO-550 온보딩 UI(URL 붙여넣기·origin 뱃지 — High: REST 플로우의 realtime 프리게이트 오배선 제거) / #641 551 연동 탭(1회성 시크릿 재표시 금지 grep 단정 — High: 삭제 다이얼로그 취소 카피) / #642 552 메모리 표시(과장 어휘 금지 단정 — High: 클릭 메타 hover 관행). 전부 design-review Blocker 0 통과 후 High 1건씩 momo-main 직접 수정.
- **통합 사고 2건(momo-main 과실)**: 632/642 머지에서 git add -A가 코드 파일 충돌 마커를 그대로 커밋 — track/uxui·main이 일시 빌드 불가(641 리뷰어가 최초 발견). 수리 완료(양측 보존+빌드 검증). **절차화: 통합 머지 후 push 전 grep 마커 검사+macOS 빌드 게이트 의무.**
- 함정 재확인: worker/게이트 스냅샷 렌더 컨텍스트 차이(641 6장·642 2장 재기록 — 오케스트레이터 환경=기준).
- 진행: 636(549 grant REST) worker. 다음: grant UI(⑮ 후보), 게이트 부채 배치, ADR-0117.

## 2026-07-22 (Fable 온보딩 배치 완주+Wave U 랜딩) · PLN-20260722-01 엔진 전장 종결, UXUI ⑨⑩⑪ main
- **PLN-20260722-01 엔진 몫 완주(main cdd78d0)**: 534 어댑터·536 카드 온보딩·535 outbound·538 동봉 eve·548 추출 동의·**537 agent_profile(ADR-0131 Accepted 집행 — 프리앰블 우선·도구 교집합·model fail-closed·요청 덤프 주입 단정)** + sol 후속 545·546·547·539. 양문형(담아오기+만들기) 전체 개통.
- **Wave U 완주**: #610(525)·#628(529 — Blocker 1+High 수정 fleet 반영)·#632(532 — Blocker 2+High 5 수정, 터미널 프리셋 정당 드리프트 재기록) track/uxui→main. 검수 함정 신규: worker/게이트 스냅샷 렌더 컨텍스트 차이(오케스트레이터 환경=기준), 설정 표면 확장發 프리셋 드리프트.
- roster verifier 선재 실패 해소(수명주기 roster의 workspace_membership JOIN — 픽스처 시드 추가, main 재현 rc=0→커밋). e2e worker 소스 복사에 services/ 누락 함정(§4 후보).
- 진행: UXUI 소비 3장 스폰(⑫550 온보딩 UI·⑬551 연동 탭·⑭552 메모리 표시 — #638~640, 성재 지시로 fleet 대행). 남은 성재 전달물: 법무 패키지. 잔여 엔진 큐: 549(grant REST).

## 2026-07-22 (Fable Wave B 완주+감사 후속) · 546·539·547·535 랜딩, 법무 패키지 완성, 548·538 스폰
- **랜딩→main(8f6fbd5)**: #629 MOMO-546 ACP 서버 릴레이(⑪ 전제 완성 — 원장+outbox+RLS PASS) / #630 539 백오프·포이즌 격리 / #631 547 env 스크럽(allowlist 기본, 마이그레이션 034) / #633 535 outbound 구독(HMAC·1회성 시크릿·자동 disable, 마이그레이션 033, OutboundHTTPPolicy 패키지로 SSRF 유틸 공용화). **Wave B(담아오기) 완주.**
- 검수 수정 1건: 617 mention 픽스처의 데이터 수정 CTE 동일 스냅샷 함정(외부 UPDATE가 신규 행 미인지).
- **공개 게이트 법무 패키지 완성**(0530c51): 의존성 37종 재감사(THIRD_PARTY 재생성, GPL 0)·NOTICE 정정·법무 확정 5항 — 성재 전달 대기.
- 스폰: 548(#625 외부 추출 동의)·538(#619 동봉 eve — 534 랜딩으로 개방). 잔여: 537=ADR-0131 승인 게이트만.

## 2026-07-22 (Fable Wave B-1 랜딩) · 534·536·545 main — 담아오기 문 개통 + sol 급소 1건 당일 봉합
- **랜딩→main**: #621 MOMO-534 eve/CF 어댑터 2종(verify_momo_channel_adapter PASS — pending→mock eve→메시지→콜백) / #626 MOMO-536 A2A 카드 URL 온보딩(전 항목 PASS — SSRF 거부·confirm·credential·RLS) / #627 **MOMO-545 memory_refs 모델 실주입**(verify_agent_context 확장 PASS — 요청 덤프에 발췌 단정). Memory Plane이 이제 end-to-end로 모델에 서빙된다.
- 검수 수정 4건(§4 12·13 성문화): 615 tsconfig verify/ 누락 / 616 addrinfo Darwin/Glibc 이식성(Linux 컨테이너에서만 발현)·verifier 고정 프로젝트명 stale 재사용 / 622는 무수정 통과.
- 진행: 623(546 ACP 릴레이) worker 가동 중 — 랜딩 시 ⑪(532) 완전 개방. 다음 스폰 큐: 535(outbound)·539(백오프)·547(env 스크럽)·548(추출 동의). 537은 ADR-0131 승인 대기.

## 2026-07-22 (Fable sol 감사 검수) · 독립 감사 브리프 실코드 재검증 — 급소 2건 확증, 티켓 4장
- 성재가 sol(GPT)과 정리한 감사 브리프를 main@e0c5336 실코드로 검수(정본 docs/planning/2026-07-22-sol-independent-audit-verdict.md). **적중 2건**: ①memory_refs가 모델 메시지에 미주입(ContextAssembler 0건 — Memory Plane이 아직 모델에 서빙 안 됨) ②workd ACP 이벤트가 로컬 JSONL 체류(서버 관전 불가 — 532 전제 갭).
- 발급: **MOMO-545(#622, HIGH 실주입)·546(#623, ACP 릴레이)·547(#624, env 스크럽)·548(#625, 외부 추출 동의)**. 가설 판정: Work Object=thin slice 연구로(즉시 ADR 반대), fidelity lane=수요 후, Collaborative Work Profile=기존 AMP 보류와 동일 결론(어휘 채택), 5-plane=대체로 기설계 일치.
- 규율 승격: "end-to-end 미연결은 완료 아님" — verifier는 최종 소비 지점(모델 요청 덤프·서버 원장 행)을 단정한다.

## 2026-07-22 (Fable 회귀 정비 + 온보딩 리서치 + 동생 반려) · runtime-agent rc=0, 제품 결함 1건 수정
- **527 전 게이트 회귀 완주**(runtime-db 핵심 PASS + runtime-agent rc=0). 8층 부검: ①pgvector 이미지 glibc 계보(→trixie digest, 상주 스택은 원 env로 재생성) ②스냅샷 드리프트 2건 재기록(카피 변경 — 511-U 부채 해소) ③멘션 패리티 단정 UUID 케이스 ④packet 스키마 문자열 ⑤~⑦fail-closed 픽스처 전환(owner 멤버십+실 install/grant+capability 등재 — §4 10 성문화) ⑧**제품 결함: 승인 재개가 grant 없는 도구에서 침묵 실패**(resume payload {} → 워커 디코드 사망; e984d9c 수정 — 서버 null 발신+워커 evidence optional, 인간 결정=권위).
- 부수 발견→후속 후보: **MOMO-539** 추출 워커 실패 백오프 부재(비-JSON 응답에 초당 수회 핫루프, 포이즌 배치 격리 없음). momo240_* 잔재 28100 선점 재확인(리클레임 사각).
- **리서치 20-01**(성재 발제 2차): eve 공식 셀프호스트+커스텀 채널 1급 API 확인, 업계 수렴=양문형(URL 담아오기/자연어 만들기)+에이전트 명부(=momo 불변식). **Wave B/C 기안**(534 어댑터·536 URL 온보딩·537 agent_profile+ADR-0131·535 outbound·538 동봉 eve) 성재 결정 대기.
- **동생 #610 반려**(design-review Blocker 1: MomoWorkspaceCopy 우회 ~30 문자열 + High 4) — PR 코멘트로 반려 패킷 게시. iOS 공식 빌드 게이트는 내가 PASS 확인.

## 2026-07-22 (Fable 패브릭 3라운드) · Wave M/A 완주 — 528·531 랜딩, 엔진 배치 종결
- **랜딩→main**: #613 MOMO-528 Context Packet v0(verify_context_packet 전 항목 PASS — 불변성·grant 서빙 필터(델타2)·revoke 재발급 제외·실 tool_grants·만료 재발급·RLS) / #614 MOMO-531 momo-acp-host(mock ACP 왕복 PASS — 승인 fail-closed·PTY 위임·029 template 경유). **패브릭 엔진 6장(526·527·528·530·533·531) 전부 main 랜딩** — 동생 ⑩(A-16/529)·⑪(A-17/532) 개방(A-16 중복 리넘버).
- 528 검수 실결함 3건(패킷 §4 7·8 성문화): 멘션 원문 FTS 질의(websearch AND가 전 매치 차단 — packet에 profile만 남던 원인) / verifier jq select 파이프 우선순위 / CONTEXT_PACKET_TTL compose 미매핑(§4-4 재발). momo240_* 잔재가 28100 선점(리클레임 사각 재확인).
- 남은 것: 회귀 게이트 잔여(runtime-agent+게이트 내 memory-search — 부하 해소 후), 529/532 랜딩 검수(동생), MOMO-534/535·0130 D4 상향 성재 결정, 공개 게이트 법무 패키지.

## 2026-07-22 (Fable 패브릭 2라운드) · 527·533 랜딩 + main 머지 + M-3/A-3 스폰 + 플랫폼 에이전트 리서치
- **랜딩→main(e7c6592)**: #611 MOMO-527 pgvector+FTS+RRF(verify_memory_search 전 항목 PASS) / #612 MOMO-533 work_tool_profile(verifier PASS). track/engine 완전 랜딩(main과 동기). **528(#598)·531(#601) worker 스폰** — 528에 델타2 서빙 필터+memory_search_hybrid grant 확장 지시.
- 검수 발견 3건(패킷 §4 성문화): 포트 28040대는 attachment와 충돌(신규=28100대부터, 27850~28093 사용 중) / 시드에 message 행 없음(verifier는 API 생성 — memory_plane 패턴) / Swift Int=bigint 바인딩이 SQL 함수 integer 파라미터 해석 실패(500) → `::integer` 캐스트. 마이그레이션 병렬 충돌: 028 중복 → 533을 029 리넘버.
- **리서치 20-00**(성재 발제): eve/Cloudflare 플랫폼 에이전트 = hermes와 본질 동일(차이=거주지·컨텍스트 소유자). momo=경쟁 아닌 "에이전트가 출근하는 사무실". 권고: MOMO-534(eve/CF momo 채널 어댑터)·535(outbound 이벤트 구독)·0130 D4 상향. 성재 결정 대기.
- 남은 것: 전 게이트 회귀(pgvector 이미지 영향 — internal-alpha 실행 예정), 528/531 검수·랜딩 후 동생 ⑩⑪ 개방, 공개 게이트 법무 패키지.

## 2026-07-22 (Fable 패브릭 1라운드) · 526·530·W-6 랜딩 + 비전 정합 델타 + 공개 게이트 준비
- **랜딩(track/engine 14c1e25)**: #608 MOMO-526 Memory Plane(docker PASS — 2-phase/무효화/워터마크/RLS, 델타1·3 오케스트레이터 가산: visibility_grant+source_kind) / #606 MOMO-530 gateway work tool(hermes 실런 rc=0) / #607 W-6 웹 Work 관전(vitest 71). **M-2(597)·A-2(600) worker 스폰** — 연쇄 진행.
- 검수 발견 3건: 596 demo password NULL 가정(진실=migration 005가 dev-password 백필 — §5.1 갱신 필요) / 599 fail() 미정의 127 / 599 approval 단정 UUID lower 누락(§5.1-3 재발). 599 사용 전제(소스 DB migrate 선행) 실측 명문화.
- **비전 정합 보수 검토**(성재 요청): 13개 요구 전수 대조 — 대주제 4개 전부 반영, 갭 3건 델타 봉합. 정본 2026-07-21-vision-conformance-review.md.
- **공개 게이트**: LICENSE(Apache-2.0) 배치, Swift 37종 감사(GPL 0), gitleaks 878커밋 실 유출 0건, ghcr 기성. 남음: THIRD_PARTY 갱신·법무 패키지.

## 2026-07-22 (Fable 기획 3차) · Momo Archive 재구성 + 메신저 심화 리서치 v0.2 (노션 정본)
- 성재 발제(집필·스터디): 노션 허브 **"Momo Archive"**(3a4c5b1cae0481739c9bc660205fc346) 개설 — 5.6 sol의 Messenger Systems Bible v0.1(00~09장)·결정 패키지·심화 리서치를 한 지붕으로 이동·체계화.
- **심화 리서치 5편 집필·게시**(1차 자료 직접 검증): 프레이밍(Geoffrey Litt "Understanding is the new bottleneck" — 제목 정정, 발표자 블로그 문서판 전문 확보) / Slack(QCon 2016+slack.engineering 12건, v0.1 교정 3건) / Discord(blog 11건+이미지 6종 육안 검증) / Mattermost(GitHub master 소스 검증 — Save↔Publish 무보장 구멍=momo outbox 정당성의 직접 증거) / Teams(MS Learn — compliance 쌍방향 기판). 각 편에 momo 대조 시사점 7~8개 포함(outbox·seq·RLS·MPNS 동형 확인).
- 개념도 3종 codex(gpt-image) 생성(세 평면·Slack 3시대·Mattermost ledger-first) — 로컬 PNG, 노션 첨부는 성재 드래그 필요(MCP가 로컬 바이너리 업로드 미지원).
- 이 작업은 노션이 정본(레포 비반영). 바이블 v0.2 개정 시 심화 리서치가 근거 문서.

## 2026-07-21 (Fable 5차) · W-5 랜딩 — 웹 트랙 W-1~W-5 완주
- **#594 W-5**(초대 링크 웹 합류): `/join`·`/i/<code>` SPA 랜딩(같은 가입 폼·403 사유별 종결 카피·replaceState 코드 제거) + LinkShort prod 편입(pinned 이미지·publish-images 가산·Caddy `/i/*` SPA보다 선행 프록시). 게이트: vitest 47·lint·build + **web-serving docker 8단정 PASS**. track/engine bfe6d51.
- **웹 트랙 완주**: W-1~W-5 전부 랜딩 — "설치 → 브라우저 접속 → 초대 링크로 합류" Mattermost급 온보딩 문법 완성. 잔여=실배포 TLS/DNS·초대 실왕복(게이트 부채 목록).
- 다음: LICENSE+ghcr(공개 게이트) → ADR-0117 기안. track/engine=main+2 — 동생 다음 랜딩과 묶어 main.

## 2026-07-21 (Fable 기획 2차) · PLN-20260721-01 승인 처리 — ADR-0129·0130 Accepted + 패브릭 배치 패킷 + Blaxel 캔슬
- 성재 지시(모바일) 5건 처리: ①노션 정리(인증 URL 발급 — 성재 승인 대기) ②UXUI 레퍼런스 분석(research/19-05, 에이전트 진행 중→도착 시 커밋) ③**Blaxel 콜라보 캔슬**(오픈소스화 전 credential 제공 불가 — E2B 베이스 확정, 진단 §5 반영) ④상세 실행 설계 main 랜딩 ⑤트랙 구조 진단.
- **ADR-0129·0130 → Accepted**("main에 설계 기반 상세 전개+트랙 실행" 지시 근거). 실행 정본 **handoffs/2026-07-21-agent-native-fabric-batch.md**: Wave M(526→527→528 메모리/pgvector/packet)·Wave A(530→533→531 gateway tool/도구원장/ACP host)·Wave U(518→529→532), 티켓 계약 원문·공통 함정(검수 축적분)·검증 규율·**오케스트레이터 인수 프롬프트(§8)** 포함.
- **트랙 진단**(2026-07-21-track-structure-diagnosis.md): 3~4트랙 세분화 기각 — 2트랙 유지+함정 체크리스트 HANDOFF_TEMPLATE 승격+정비 배치 정례화+공개 시 한시 release 트랙. 전환 트리거 4종 명시.
- **다음**: 성재가 패킷 §8 프롬프트를 오케스트레이터 세션에 전달 → momo-main 통합(BUILD_TICKETS 이관·Issue 발급·ENGINE_HANDOFF 갱신). 노션은 인증 완료 시 이 세션이 페이지 생성.

## 2026-07-21 (Fable 4차) · 웹 완성 배치(W-3·W-4) + 이중트랙 main 머지(53c457a)
- **W-3**(#581): Caddy `{$APP_DOMAIN}` 서빙 — web-init named volume·같은오리진 프록시·centrifugo 403·CSP. `verify_web_serving.sh` docker 6단정 PASS(web-serving infra 프로파일 신설). **W-4**(#580): 웹 승인 카드(멱등 결정)·read-state debounce·recovery reconcile·재연결 배너 — vitest 38·lint·build PASS. **"서버 URL이 곧 웹 주소" 완성**(prod TLS/DNS만 실배포 시 검증).
- **이중트랙 main 머지**(성재 사전 승인 "작업 마무리 되는대로"): engine(574 수명주기완결·580·581) + uxui(511-U 개방·505·506 — 동생 ①②) → main 53c457a. 게이트: server build + real-window 4/4. 동생은 그새 **③(517 관전 터미널 #575)까지 track/uxui 랜딩** — 페이스 탁월.
- 남은 게이트 부채(runtime-unverified 누적): iOS 505/506 시뮬 스냅샷·모바일 E2E 1왕복, 517 2계정 owner↔observer 실증, 웹 승인 실왕복, 511-U 선재 스냅샷 드리프트 2건 재기록. 다음 내 큐: W-5(초대 웹 합류)·LICENSE+ghcr(공개 게이트)·ADR-0117 기안.

## 2026-07-21 (Fable 기획) · PLN-20260721-01 에이전트-네이티브 비전 리서치 완료 + ADR-0129/0130 기안
- 성재 발제(CTO 대화 4대 고민+Blaxel cofounder 접촉) → 병렬 리서치 5기(내부 실사 2+외부 3) 완료, **research/19-agent-native-fabric/00~04** 저장(컨텍스트/메모리 실사·연동 표면 실사·프로토콜 지형·메모리 OSS·샌드박스 유휴 경제/Blaxel).
- 진단 정본 **docs/planning/2026-07-21-agent-native-vision-diagnosis.md**: cowork=0126 잔여 실행만(518 승격 권고) / 에이전트 호스팅=막힘 3곳, ACP 클라이언트로 40+ 에이전트 즉시 호환 / 규격 공백 실재("구현→스펙 추출" 순서, 창 12~18개월) / 메모리=최대 갭(PG-native 유일 경로, pgvector 도입) / Blaxel=명시 기각 아님·2nd 기질 후보+협상 카드, CTO 유휴 질문 직답 포함(E2B·Blaxel 메모리+FS 보존 재개 가능, 보관비 E2B 미명문화 vs Blaxel $0.20/GB-월).
- **ADR-0129**(Memory Plane & Context Fabric 런타임, MOMO-526~529 예약)·**ADR-0130**(외부 코딩 에이전트 멤버십·ACP, MOMO-530~533 예약) **Proposed** 기안. 구현-설계 정합 리뷰 6건(R1~R6)은 진단 §6 — 위반 0, 스펙 대비 미완 관리 항목.
- **성재 대기**: ①0129/0130 옵션 승인 ②우선순위 결정(진단 §7: 0129→0130→518 승격→Blaxel 미팅) ③Nicolas(Blaxel) 답장 발신 여부 — 초안은 세션 보고에 전달.

## 2026-07-21 (Fable 3차) · MOMO-524 랜딩 — ADR-0128 서버 절반 완전 종결 + 동생 ①② 순항
- 2차 배치(565 S3·566 멤버십) main 랜딩(49edf5d, 성재 승인). **#574 MOMO-524**(self-leave·agent credential 대칭·banned handle 생성차단·audit 조회 REST) track/engine 8cd20a2 랜딩 — docker 실런 PASS(self-leave/대칭/ban/audit/RLS) + 523 회귀 PASS. **ADR-0128 D1~D6 서버 전부 완결** — 잔여는 UXUI 525(=A-15, worker가 ENGINE_HANDOFF 등재)뿐.
- 검수 수정 2건: 전송 응답 jq 경로(.message.id→.id — 응답은 top-level 객체), e2e compose gateway 기본 비활성이라 agent 대칭 probe용 AGENT_GATEWAY_MODE=gateway override 가산.
- **동생 진행**: 순차 배치 ①(511-U 개방 #567/568)·②전반(505 Work 탭 #569/570) track/uxui 랜딩 — 순서 준수·페이스 양호. 506 진행 추정.
- 도달점 보고(성재 전달됨): L1~L3 100%·L5 ~90%·오픈소스 4대 관점 중 ④ 블로커 해소·권한 수명주기 완결. 다음 큐: W-3/4/5(웹 완성), LICENSE+ghcr(공개 게이트), ADR-0117 기안. **성재 대기**: track/engine→main(574).

## 2026-07-21 (Fable 2차 배치 완결) · S3 어댑터 + 멤버십 수명주기 랜딩 — track/engine=main+2 승인 대기
- **#565 MOMO-521**(S3 첨부): SigV4 SDK-less·presigned 직송·MinIO 프로파일. docker s3 실런 PASS(왕복/RLS/audit/redaction). 셀프호스트 하드 블로커 해소. **#566 MOMO-523**(멤버십 수명주기 D1~D3): workspace_membership 분리·역할변경·suspend/추방/ban·audit·guest 투영. docker 실런 PASS(lifecycle/hierarchy/guest/audit/RLS).
- 검수 중 잡은 결함(오케스트레이터 수정, PR에 커밋): ①**서버 2계열 500** — nil String?/UUID? 바인딩 'could not determine data type'(Roster/Lifecycle/Join/WorkControl 4곳 ::text/::uuid) + **트랜잭션 내 HTTPError가 PostgresTransactionError로 감싸져 500**(라우트별 ad hoc unwrap을 Database.withTenantTransaction 중앙 unwrap으로 승격 — 재발 원천 차단) ②verifier 3건 — bash 3.2 빈 배열, api 컨테이너 curl 부재(mock-hermes python 대체), demo 계정 password 시드.
- 함정 축적: nil 바인딩 ::캐스트·트랜잭션 HTTPError·bash 3.2 배열·컨테이너 내 curl 부재 → 이후 패킷 규율에 반영할 것. UXUI 순차 배치(9항목)는 동생 진행 중. **성재 대기**: track/engine→main(565·566), MOMO-524(D4~D6) 후속 발급.

## 2026-07-21 (Fable 오픈소스 배치 완결) · 519 랜딩 — 배치 4/4, track/engine=main+5 승인 대기
- #562 MOMO-519 티어 폴백 랜딩(track/engine 9cae37e): docker verifier 최종 PASS(ask/t1_only/auto/orphan/resume/push/RLS). 검수 중 verifier 결함 4종을 오케스트레이터가 수정(포트 중복 28023 → hermes 28024 분리 / INSERT...SELECT uuid·message_type·jsonb 캐스트 / Swift UUID 대문자 vs 시드 소문자 lower() 3곳 / RLS 단정 psql -q 부재로 명령 태그 오염). keep-stack 부검으로 구현 무죄 확정(카드·RLS 전부 정상 — 단정만 결함). X-8 done(#560 remoteAttachAvailable).
- perm-research 서브에이전트 좀비화(named spawn mailbox 전례 재발 — 메모리 교훈 위반, 재확인) → 손절, InfoQ 직접 fetch + 공지식으로 research/18-permissions-workspaces/00 작성(Slack V1→Grid→Unified Grid·Vitess 채널 샤딩·권한 헬퍼 중앙화 / Discord 계층·kick/ban / Mattermost·Matrix / 공통 패턴 8 / momo 시사점: 재샤딩 불요·0117=스키마 작업).
- **성재 대기**: ①track/engine→main 머지 승인(main+5: 560 관전·561 웹·562 폴백) ②ADR-0127(S3 스토리지) ③ADR-0128(멤버십 수명주기 — MOMO-523~525 발급 대기). 유지: momowebqa+vite(:5173) 성재 육안용.

## 2026-07-21 (Fable 오픈소스 배치) · 웹 탄생 + 관전 attach 랜딩 + 티어폴백 검수 중 + 권한 ADR-0128 기안
- 성재 승인: 이중트랙 main 머지(8f9408f) + 우선순위 실행. ADR: 0126(관전)·0125 D11(티어폴백) **Accepted**, 0127(S3 스토리지)·0128(멤버십 수명주기 — 역할변경/suspend/kick/**ban**/self-leave/audit/에이전트 대칭) **Proposed 성재 대기**. 진단 2건: 2026-07-21-opensource-cowork-diagnosis.md(웹=0119 기이행 대기·셀프호스트 갭 4·cowork 갭 4) / 2026-07-21-permissions-workspace-diagnosis.md(P1~P7 — 초대는 강함, 수명주기 API 전무, 0117 멀티워크스페이스 미기안).
- **랜딩(track/engine)**: #560 MOMO-516 관전 attach(observer capability+X-8 remoteAttachAvailable — verifier+511 회귀 PASS) / #561 **W-2 clients/web**(Vite+React, vitest 20·실서버 육안·실전송 PASS — momo 세 번째 클라이언트. 컴포저 범위초과=deviation accepted, W-4 축소로 상쇄). track/engine=main+3(560·561 머지커밋 포함).
- **진행 중**: #562 MOMO-519 티어폴백 검수 — notifier/workd 테스트 PASS, verify_tier_fallback은 worker의 포트 중복 버그(HERMES=PUSH=28023) 발견·오케스트레이터 직접 수정(HERMES→28024) 후 3차 실행 중. 이 수정은 559 브랜치에 커밋 필요. Slack/Discord 권한 리서치(deep-research) 마감 요청함 — 도착 시 research/18-permissions-workspaces/00에 저장.
- 유지 중 스택: momowebqa(:28000)+vite dev(:5173 — 성재 육안용 크레덴셜은 QA_FOLLOWUP Q9 계정). worker 사고 1건(zsh 1-기반 배열로 워크트리 매핑 어긋남 — main 무사, 재발 방지: spawn 루프에 명시 매핑 사용).

## 2026-07-21 (Fable fleet 완결) · MOMO-513 수정 랜딩 — 위임 배치 4/4 종결
- 553 worker(#556): outbox broadcastPayload에 `props: responsePropsJSON` 1줄 + 서버 테스트·verifier 양면 단정(mention REST↔outbox 일치, edited props 보존). 오케스트레이터 docker 실런 `verify_message_interaction.sh` PASS(실 Centrifugo 발행 props 단정) → track/engine e53c24d. **X-9 종결**. QA 스택 momo543qa teardown 완료.
- **최종 대기 상태**: track/uxui=main+4(543·499·511-U), track/engine=main+2(503·513) — 성재 main 머지 승인 대기. 다음 큐: X-8(ptyId 투영), MOMO-514(iOS 토큰 UX), iOS 500~/504~506, 490.

## 2026-07-21 (Fable fleet) · 이중트랙 위임 배치 — 499·503·511-U 랜딩 + 543 육안 QA PASS + 결함 2건 발견
- 성재 위임("UXUI트랙 fleet + 엔진 + 543 ⓑ"). worker 3기(548=511-U·549=499·550=503, 5.6-sol medium) 스폰 → 전기 PR 완주. 검수+게이트(오케스트레이터): 549 시뮬레이터 게이트 PASS(47/47)→#551 / 550 docker verifier PASS(4카테고리·thread_id·approval_id·ADR-0109 badge·억제0)→#552 / 548 build green+real-window 4/4+스냅샷 2실패=선재 flake 베이스라인 재현 확정→#555. **track/uxui=main+4(543·551·555), track/engine=main+1(552)** — 성재 승인 시 main.
- **543 육안 QA ⓑ 완료(PASS)**: 격리 스택+실 REST 시드 213건+시뮬 실로그인. 증거 세트(캡처6+영상) 성재 전달. 상세 QA_FOLLOWUP Q9.
- **발견**: A=MOMO-513(#553) send() outbox props 미탑재(라이브 멘션/인용/승인 props 누락 — 콜드/라이브 A/B 격리, MessageRoutes.swift:242) worker 수정 중 / B=MOMO-514(#554) 토큰 만료 시 타임라인 전체 에러+Retry 무효. X-8(ptyId 투영)·X-9 ENGINE_HANDOFF 등재.
- 도구: applesimutils+idb 확립(시뮬 자동 QA, 형 화면 무침범). QA 스택 momo543qa(:28000)는 513 검수 재현용으로 유지 — 종료 시 `docker compose -p momo543qa -f infra/docker-compose.e2e.yml down -v`.

## 2026-07-21 (Fable 재개) · 509·511 런타임 verifier 종결 + 543 track/uxui 랜딩
- main c953322에서 오케스트레이터 docker 실런: `verify_agent_create.sh`(509) — fresh DB 생성·409/403·pairing·credential·audit·RLS PASS / `verify_terminal_attach.sh`(511) — 발급·만료·소유자·revoke·raw 직결 우회·audit/RLS PASS. STATUS의 두 항목 `runtime-unverified`→`runtime-verified` 갱신(엔진 deviation 종결).
- 543(iOS 타임라인 v2): base 전진으로 STATUS 충돌 → 541 워크트리에서 union 해소·push → track/uxui 랜딩(a06d050). 컴파일+41 tests PASS. **남은 것=498 "인증 실데이터 육안"**(라이트/다크·Dynamic Type·한국어 3줄·200+ 스크롤) — STATUS에 runtime-unverified 명시(496/497 선례와 동일 수동 게이트). 성재 기기 확인 또는 Fable 실데이터 시드 캡처 택1.

## 2026-07-21 (Fable 통합) · 이중트랙 main 머지 완료 — 512 차단 해소, 엔진 파이프라인 재개
- 성재 위임("너가 해…검수한다음에 작업재개까지"). 547(512 focus fix)를 546 워크트리에서 real-window 직접 확증(실디스플레이 XDR — testComposerFocusRequestRestoresKeyboardFocusInRealWindow 등 real-window 4/4 PASS, XCTSkip 아님) → track/uxui 랜딩(e297dd3). 543(iOS 타임라인 v2)은 541 워크트리 시뮬레이터 게이트 PASS(BUILD/TEST SUCCEEDED·41 tests). iOS Archive CI fail은 main에서도 action_required = pre-existing 서명 이슈(코드 회귀 아님) 확증.
- **이중트랙 main 머지**: track/uxui(496·497·536·547) + track/engine(491·509·511) → main c953322. 충돌은 docs만(STATUS union·ADR-0125 keep-ours, 코드 충돌 0). 머지 결과 게이트: real-window 4/4 PASS + server swift build 완료. 세 ref(main·track/engine·track/uxui) c953322 정렬(ff 재동기화). **성재 맥 real-window 재실행 불요**(Fable가 실디스플레이로 확증함).
- 남음: 543 시각 QA(라이트/다크·Dynamic Type·한국어 3줄·200+ 스크롤) 후 track/uxui 랜딩 / 509·511 docker 런타임 verifier(runtime-unverified→verified) / 엔진 다음 큐.

## 2026-07-21 (Fable 검수) · MOMO-512 focus 회귀 수정(#547) 검수 CLEAN + 이중트랙 main 머지 시퀀스 준비
- 동생 PR #547(track/uxui) 검수: 근본원인=`@FocusState`가 NativeTextView(NSViewRepresentable)가 준 적 없는 focus 진실을 소유. 수정=`@State` 전환 + `viewDidMoveToWindow` 재동기화(rootView 교체 타이밍) + stale async firstResponder 탈취 방지(`textView.window === window`) + `onChange(initial:true, guard request>0)`(mention 오버레이 직접 focus 경로 보존). **결정타**: `textDidBeginEditing/EndEditing`가 바인딩 set으로 @State를 되써서 blur 시 stale-true 없음 → focus 재탈취 회귀 없음. 445/445·macos-ui 31/31·real-window 반복 PASS(동생).
- 준비: 동생 → 547·543(498) track/uxui 랜딩(자기 트랙, 승인함). **성재 승인 대기 이중트랙 main 머지**: track/uxui(496·497·536·498·512fix) + track/engine(491·509·511)을 원자적으로 함께 → main real-window 즉시 green. 최종 확인=성재 맥에서 `swift test --filter MemberInspectorSnapshotTests/testComposerFocusRequestRestoresKeyboardFocusInRealWindow` 1회(clients/macOS, 실 디스플레이) → 512 종결·509/511 런타임 검증.
- 남음: 543(498)은 성재 육안 QA(라이트/다크·Dynamic Type·한국어 3줄·200+ 스크롤) 선결. 엔진 새 기능은 머지 전까지 보류(미머지 스택 억제).

## 2026-07-20 (Fable 엔진 트랙) · 엔진 배치 랜딩 + 508 real-window 회귀(파이프라인 차단자)
- 랜딩(track/engine): MOMO-491 openssl 이식(#540)·509 X-7 에이전트 생성 API(#542)·511-E D10 attach capability(#545). 파일럿 E2-A 경제·E5 GitHub 사이클·E3 부분 완료. ADR-0125 D9(구독연결 UX)·D10(원격 attach) 기안.
- **차단자**: MOMO-508(컴포저 TextField→NativeTextView)이 real-window focus 복원 테스트를 결정적으로 깸. 헤드리스 게이트는 XCTSkip이라 508 통과했으나 실 디스플레이(성재 맥·runtime-db make test)에서 드러남 — 509·511 게이트 둘 다 걸림. 서버 전용이라 각 verifier 격리 PASS 확인 후 deviation 랜딩, MOMO-512로 동생 이관+정밀 진단(focusComposerRequest→isFocused 브리지).
- 검수 성과: 509/511 무죄(엔진 베이스 재현), 두 worker 포트 충돌(27970) 선제 수정(511→27980), 부하 게이팅 24 거부 준수. track/engine=main+3. 다음: 512 수정이 엔진 게이트 정상화 선결.

## 2026-07-20 (Fable 기획) · iOS v1 모바일 개편 계획 기안 (성재 승인 대기)
- 성재 발제(Discord·Mattermost·Claude 앱 레퍼런스 스크린샷) → docs/planning/handoffs/2026-07-20-ios-v1-mobile-plan.md. MOMO-496~506 예약: A(아이콘·탭 셸) → B(타임라인 v2·상호작용·스레드·첨부·검색) → C(푸시 v2 — 엔진 E-1 포함·C-3 딥링크 종결) → D(Work 탭·세션 상세 관전/개입 — Claude 앱 모델, 모바일 E2E 수용).
- 원칙: 모바일=관전과 개입(실행은 호스트). 엔진 의존은 E-1(푸시 페이로드 v2)만 신설 — 나머지는 전부 main 기랜딩 소비. codex iOS plugin worker 규율(컴파일=오케스트레이터) 명문화.
- 병행 상태: Q1c 스택 부팅 중, 495 랜딩 완료(a37026b).

## 2026-07-20 (Fable 통합) · A-11+Hermes(uxui) + X-6+489(engine) 동시 main 랜딩 — Q1 개방
- uxui@9ac0bd7(A-11 자기등록·실 Hermes E2E) 검수 결함 0 → main. engine(X-6·work_pool) → main a96f9c8. 3트리 정렬.
- 동생 발견 갭 X-7(에이전트 생성/pairing API — fresh DB 완주 불가) 등재·MOMO-494(#532) 발급. QA 판단: Hermes 멘션 QA는 즉시(트랙 스택), Q1 풀 사이클은 main 랜딩 후 — 지금 충족.
- 다음: Q1 실사용 QA(성재+Fable, AgentWorker MOMO_WORK_HOST_ID 조율) → 490(호스트 선택기)·X-7·491.

## 2026-07-20 (Fable 엔진 트랙) · X-6(493)+work_pool(489) 랜딩 — 0125 파생 3/4 완료
- 493(#529): auto-approve GET(human 전용·자기것만·tool만) — A-11 소비 짝. 489(#531): work_pool 슬롯 원장(FOR UPDATE 직렬화·구조화 409·집계 회복·admin audit). 둘 다 verifier+게이트 실패 0.
- 검수 실측 결함 1건(489): 기본행 included_active_hours=NULL이 audit jsonb_build_object 바인딩에서 타입 미상 PSQLError→빈 본문 500 — 스택 유지 재현으로 확정, ::int 캐스트 수정. **jsonb 내 nullable 바인딩은 명시 캐스트** 교훈.
- track/engine = main+2(493·489). 0125 파생 잔여: 490(UXUI 호스트 선택기 — A-11 뒤 동생 큐)·momo Cloud 프로비저너(T3 파일럿 후). 다음: 동생 A-11 검수 대기, 491(openssl 이식) 소형 정리 후보.

## 2026-07-20 (Fable 통합) · A-10 Work Console 검수 완료 + QA 팔로업 트래커 개설
- track/uxui@940369e(5169ef5, +2,311) A-10 검수: 코드 결함 0. SwiftTerm 1.14.0(MIT, exact pin·macOS 전용)·환경 allowlist(PATH/SHELL/TMPDIR만·TOKEN/cwd/PWD 배제 테스트)·host 필터·control dedup·세션종료 dedup·raw 로컬 파일 전용·샌드박스 fail-closed. macos-ui 게이트+420 tests PASS(동생 보고).
- **머지 미실행**(성재 명시 승인 대기 — TRACKS 규칙). App Sandbox 배포 정책은 blocker 아님으로 판정: dev 빌드 동작+샌드박스 fail-closed 안전, 배포판은 momo-workd(T2) 위임이 정답 → ADR-0114 보강.
- **QA_FOLLOWUP.md 개설**: Q1~Q8(A-10 실사용·샌드박스 결정·X-6·C-4·C-1·C-3·T3 E2/E3/E5·491)을 [자동]/[함께]/[성재] 분류·검증방법·트리거·수용조건으로 정리. 필요 시점에 함께 진행.
- X-6(auto-approve snapshot) ready 역핸드오프 확인. 다음: A-10 머지 여부 성재 결정 대기, 엔진 488 게이트 진행 중.

## 2026-07-20 (Fable 엔진 트랙) · MOMO-488 momo-workd v0 구현 완료 — verifier/게이트 대기(성재 지시 일시중단)
- 488(#525, PR 미생성) worker 완주·전량 push(goal `feat/525-momo-workd-v0-adr-0125-d2` @8cb2fe2, origin 동기화, 워크트리 clean). 신규 workers/WorkHostDaemon(momo-workd) + 서버 poll 엔드포인트(GET .../work-hosts/:id/pending-controls, 호스트 서명 인증) + infra/workd 배포 아티팩트.
- Fable 검수 완료(코드 결함 0): poll=호스트 서명 전용(bearer 불가)·host≠agent 경계·ack 페이로드 raw 미포함·process 출력 로컬 파일 전용(D3 정합). server 121/workd 6 통과. verify_workd는 openssl 미사용(내부 Crypto)이라 LibreSSL 게이트 함정 없음.
- **재개 지점(다음 작업 = verifier부터)**: ① goal 워크트리(feat/525…)에서 `bash -lc scripts/verify_workd.sh`(포트 27950대) → ② `scripts/local_gate.sh --profile runtime-db` → ③ PASS 시 PR 생성·squash→track/engine·이슈 #525 close·워크트리 회수 → ④ 다음 엔진 = MOMO-489(work_pool). 배치 종료 시 docker reclaim.
- 참고: 게이트 반복+파일럿으로 Docker 압박 → 이번 세션 build cache 24.6GB 회수 완료. 파일럿 E2/E3/E5·MOMO-491(push_relay openssl 이식) 잔여.

## 2026-07-20 (Fable 엔진 트랙) · MOMO-487 work_host 레지스트리 랜딩 + 게이트 openssl 함정 해소
- 487(#523 → track/engine): work_host(scope member|workspace·Ed25519·revoke) + work_session/control FK + 등록/서명 heartbeat/revoke + control 대상 검증(revoke 시 dispatch 차단→failed). verify_work_host + 게이트 실패 0.
- 검수 실측 2건: ①신규 호스트 online 투영 NULL→false(비옵셔널 디코드 500) ②**게이트 bash -lc 로그인 셸이 /usr/bin/openssl(LibreSSL, ED25519 미지원)을 homebrew보다 먼저 잡아** verify가 무출력 실패(cleanup 무에코→게이트 로그 0줄) — find_openssl 리졸버로 해소. push_relay 동일 패턴 이식은 MOMO-491(#524).
- Docker 자원 회수(배치 종결 계약): build cache 24.6GB→0. 다음 파일럿 E2(경제)·E5(통합 데모)와 0125 파생 488(workd) 잔여.

## 2026-07-20 (Fable 엔진 트랙) · ADR-0114 엔진 체인(483·484·486) 완주 — track/engine, main 대기
- 483 work_session 원장(#517) → 484 work.control+승인 게이트(#519, worker capacity 사망 7커밋 인수) → 486 AgentWorker tool+E2E(#521). 전부 verifier+runtime-db 게이트 실패 0.
- "채팅 멘션 → 에이전트 work_spawn → 승인 카드 → 호스트 ack+세션 → 스레드 개입"이 mock E2E로 완결. 486이 run-liveness 가드(죽은 run 명의 control 차단)를 추가해 484 verifier를 계약 정합 갱신.
- 다음: 성재 승인 시 엔진→main 머지 → A-10(MOMO-485 SwiftTerm) 동생 위임+QA 패키지 → T3 파일럿(17-01) 착수 → 0125 파생 487~490.

---

## 2026-07-19 (Fable 통합) · UXUI A-4/A-6 배치 → main ff (성재 승인)
- track/uxui@37bcd12(+2,252) 최종 리뷰 Blocker/High 0: capability URL 무유출(ephemeral 직송·Authorization 원천 부재)·complete 6필드 대조·tombstone 첨부 가드·replies root 탈출 검증·경로 방어 2중 전수 코드 대조. main 동기화 후 게이트 재실행 PASS(416/416) → main=8607580 fast-forward.
- A큐 전 항목 done — 핸드오프 UI 큐 완전 소진(A-1~A-9). 잔여: 동생 제기 orphan 첨부 GC(complete-미귀속 행) 엔진 티켓화 예정, Drive 실자격 E2E·2기기 수동 QA는 검증 부채 유지.
- 트랙 재정렬(engine=uxui=main). 다음: MOMO-483 랜딩 시 A-10(Work 서랍/SwiftTerm — MOMO-485)이 UXUI 다음 소비물로 등재 예정.

## 2026-07-19 (Fable 기획+엔진) · ADR-0114 Accepted → MOMO-483 착수 + ADR-0125 기안
- 성재 "ㄱㄱ"로 0114 v2(D1~D8) Accepted. MOMO-483(#516, work_session 원장+세션 카드/스레드 바인딩) 발급·worker 가동 — no-version 발행·비순번 분기 등 479/480 확립 계약을 패킷에 명시.
- ADR-0125(Work Host Fabric) Proposed 기안: work_host 레지스트리(scope=member|workspace·outbound-only) · T2 workd(SSH 부트스트랩·원격 로그인 브리지) · T3 재판매 시작(기질-불가지 프로비저너, 자체 Firecracker는 v2) · 3계층 샌드박스 합성 · work_pool 동적 슬롯 · 호스트 선택기(로컬 우선) · 워크스페이스 과금+BYOA · 보안 기본값. 파생 487~490 예약. 성재 승인 대기.

## 2026-07-19 (Fable 기획) · ADR-0114 v2 재기안 — Warp/Conductor형 에이전트 조종 터미널
- v1(수명주기만 원장·경로 분리) 기안 직후 성재 방향 보정: 기본 흐름=채팅 요청→에이전트가 CLI 세션 스폰·조종·작업 제공, 세션↔채팅 양방향. v2로 재기안.
- v2 권고: D1 호스트 세션 매니저(앱 내장, workd v1) · **D2 세션=채널 스레드**(카드 root+진행 답글+개입 답글 — X-3 인프라 재사용) · D3 큐레이션 기본·raw tail 옵트인 · **D4 원장 경유 control**(에이전트 tool-call work.spawn/input/read/kill→승인→outbox→호스트 실행) · **D5 spawn=승인 대상**(프로파일 auto-approve 화이트리스트) · D6 터미널+스레드 병행 · D7 도구-불가지 프로파일.
- 논거: 기존 5자산(mention→run·승인·partial·단일 쓰기경로·BYOA) 재사용 계약이지 새 시스템이 아님. 파생 483(세션 원장)/484(control+승인)/485(UXUI 터미널)/486(AgentWorker tool+E2E). 성재 승인 대기.

## 2026-07-19 (Fable 엔진 트랙) · MOMO-472 스냅샷 flake 근본 수정 (track/engine f74bae2)
- 원인 확정: MemberInspector·WindowChrome의 NSApp.appearance 전역 변조(비동기 전파)가 인접 무창 스냅샷 렌더를 오염 — 풀스위트 한정·격리 통과·부하 발현·family 고정 관측 전부 정합. worker 위임 불가 유형(게이트 env 재현)이라 오케스트레이터 직접 수정.
- 전역 변조 3사이트 제거(창/팝오버 외관 기설정 — 잉여 증명: 오염원 자기 스냅샷 18/18 정본 일치). evidence: 유휴 풀스위트 3×405 그린 + macos-ui 게이트 PASS. #495는 재발 감시로 유지, 무재발 확인 후 close.
- track/engine = main+2(MOMO-482 + 472수정). 잔여 백로그는 성재 필요: C-2(Codex 왕복)·C-4/C-1(2기기·마이크 수동 QA).

## 2026-07-19 (Fable 엔진 트랙) · MOMO-482 X-4 첨부 투영 랜딩 — X큐 소진
- 482(#515 → track/engine): history/전송/replies/message.new에 complete 첨부 투영(LATERAL 단일쿼리) + Core Message.attachments/DraftMessage.attachmentIds. 확장 verifier·게이트 실패 0. worker 리뷰 결함 0.
- 이로써 **UXUI 역요청 X-1~X-5 전량 소진**. track/engine=main+1(482) — 다음 성재 승인 머지 때 A-6 ready 전환.
- 잔여 후보: C-2(Work 실 Codex 왕복), C-4(2기기 수동 QA), MOMO-472(스냅샷 flake 안정화 #495).

## 2026-07-19 (Fable 엔진 트랙) · X-5 체인 완주 — MOMO-480/481 랜딩
- 480(#511): 상호작용 이벤트 no-version 발행(브로커 드랍 해소) + verifier history 실수신 회귀 가드. 481(#513): Core replay type 분기(커서 불전진)·history tombstone/편집 투영·재시작 수렴 단정. 둘 다 runtime-db 게이트 실패 0.
- track/engine = main+5(479·재정렬·480·481). **main 랜딩 시 A-9 done·A-4 ready 전환 가능** — 엔진→main 머지 성재 승인 대기. 실 2클라 ws E2E는 C-4 등재(수동 QA 대체 가능).
- 다음 엔진 후보: X-4(첨부 수신 투영 — A-6 개방) 또는 C-2(Work 실 Codex 왕복).

## 2026-07-19 (Fable 통합) · UXUI A-8/A-9 배치 → main 머지 (성재 승인)
- track/uxui@dae7e8a(+1,945) 검수 결함 0 → main f25503d 무충돌 머지. A-8 음소거 UI 완결, A-9는 REST/로컬 UI 범위(4종 실호출·fail-closed·경합 방어) — 교차 클라 realtime·재시작 복원은 X-5 대기(성재 선택지 1 채택).
- UXUI가 X-5(상호작용 이벤트 seq 재사용 → relay/Core drop + history 투영 부재)를 정확히 역요청 — 엔진이 독립 실측한 MOMO-480(브로커 절반, 게이트 진행 중)과 동일 근원. 잔여(Core replay 비순번 처리·history editedAtMs/state 투영·2클라 verifier)는 MOMO-481 후보.
- 트랙 재정렬(uxui=main), 앱 재빌드. 엔진 트랙은 main+2(479+480 대기)로 계속 전진.

## 2026-07-19 (Fable 엔진 트랙) · MOMO-479 X-3 스레드 투영 랜딩 + 478 선재 결함 발견
- X-3 완주(PR #509 → track/engine): thread 롤업 투영·replies cursor REST·thread.updated·AgentWorker root_id 보존(4사이트). worker(gpt-5.6-sol) 34분 구현, 리뷰 결함 0.
- **실검증에서 결함 2건 잡음**: ①thread.updated가 Centrifugo version 게이팅에 무언 드랍(version=답글 seq ≤ 저장 version — no-version 발행으로 수정) ②동일 기전으로 **MOMO-478 상호작용 이벤트 4종 상시 드랍**(선재) → MOMO-480(#510) 발급. outbox done이라 무증상인 함정 — A/B 발행 실측으로 확정.
- 게이트 부산물: e2e compose `cp -Rp`+`swift run -j 8`(Docker VM 7.7GiB OOM 실측 대응, 전 verifier 수혜), verifier 포트를 워크트리 runtime 포트와 분리, QuickSwitcher 스냅샷 4건 MOMO-472 family 재확장(#495).
- 다음: MOMO-480(A-9 개방 전 필수) → X-4(첨부 투영). main 반영은 성재 승인 대기.

## 2026-07-18 (Fable 통합) · 양 트랙 → main 동시 랜딩 (성재 승인 머지)
- UXUI 배치(6e43928, +5,758) 검수 완료: 웹훅 시크릿 무영속·단축링크 URL 검증·타임라인 rootId 필터·검색 stale 가드 전부 주장=코드 일치, macos-ui 게이트 풀 PASS. 결함 0 — 수정 없이 머지.
- 머지 순서 uxui(2998b23)→engine(7e7b283). ENGINE_HANDOFF 통합판 작성(A-1/2/3/5/7 done · A-4/6 in-progress · A-8/9 ready · X-3/4 needs-engine-contract), 트랙 브랜치 양쪽 main으로 ff 재정렬.
- 통합면 검증: 엔진 머지가 uxui 게이트 트리에 더한 것은 server/workers/scripts+Core 테스트뿐(macOS 소스 무접촉) — 양 게이트 evidence가 merged main을 그대로 커버.
- 다음: UXUI에 A-8(음소거 UI)·A-9(상호작용 개방) 제안, 엔진 다음 작업=X-3(스레드 조회 계약)·X-4(첨부 투영).
- 5티켓 순차 랜딩: 골격 `cb2f753` → 목록/타임라인 `daff55e` → 컴포저/승인 `9aad292` → 푸시 P-4 `a0e3d0c` → TestFlight 런북 `3d321c6`. 전부 codex worker 구현→Fable 리뷰·시뮬레이터 게이트·머지.
- 파이프라인 실측: worker 샌드박스는 CoreSimulator/xcodebuild 불가 — iOS 컴파일·시뮬레이터 검증은 오케스트레이터 상시 몫(Swift 6 sending 오류 3건 직접 수정 전례). capacity 사망 1회는 동일 worktree 이어받기+빈번 커밋으로 유실 0 복구.
- ADR-0120 전 체인 종결(P-4 포함, simctl push 실전달·NSE 18/18). 잔여: 런북 [manual](성재 실기기 E2E)이 배치 최종 evidence. ADR-0123 v1 수렴 항목(뷰모델 공용화)과 M8 이월(042/043) 유지.

## 2026-07-17 (Fable 기획) · ADR-0123 iOS 클라이언트 v0 기안
- 성재 발제로 iOS 트랙 기획 착수. 실측: MomoCore 20파일 AppKit 0(그대로 재사용), 레거시 EP-IOS 분해(040 승계·041 기완성·042/043 M8 이월), 팀/APNs 전제 금일 확인 완료.
- D1~D6 기안: 얇은 셸+MomoiOSKit / dogfood 스코프(수신·답장·승인 결정 — "이동 중 승인"이 차별점) / P-4 합류 / TestFlight internal / codex iOS 플러그인 구현+ios 게이트 프로파일 / IOS-1~5 순차 배치.
- 다음: 성재 D1~D6 승인 → Accepted 반영 → IOS-1 패킷 발급.

## 2026-07-18 (Fable) · B-4 완료 — 엔진 역요청 전량 소화
- MOMO-477(음소거) track/engine 랜딩: pref REST+채널 목록 muted+notifier 판정 join(멘션 포함 억제·로그 무오염·만료 자동 재개). ADR-0124 Accepted 즉일 구현.
- 이로써 갭 감사의 B(역요청) 4건 전부 종결(B-1 첨부/B-2 검색/B-3 스레드/B-4 음소거). UXUI A큐는 8건(A-8 음소거 UI 추가). X-1 이식 완료, X-2(반응/수정/삭제 REST)가 엔진 다음 작업.
- track/engine = main +2(X-1 스테이징 픽스, MOMO-477) — 다음 성재 승인 머지 대기.

## 2026-07-18 (Fable) · 엔진 3차 main 머지 `7edad20` — UXUI 큐 전면 개방
- 검색 FTS(MOMO-475)+스레드 개방(MOMO-476) 통합 게이트 PASS 후 성재 승인 머지. 트랙 재정렬(main=engine).
- ENGINE_HANDOFF 재구성: A 7건 전부 "main 랜딩·즉시 착수 가능"(마켓플레이스/웹훅/단축링크/스레드/첨부/검색/허들 폴리시). 엔진 잔여=B-4 음소거 ADR, C-2 Work 실검증.
- 성재가 UXUI에 전달할 멘트 작성 완료(세션 로그) — UXUI는 A 항목을 "이거 구현할까요?" 루프로 소비 시작.

## 2026-07-18 (Fable) · 엔진 트랙 main 머지 `bd77fe5` (성재 승인 2차)
- track/engine→main: V-3b iOS 허들 참가(#498) + 첨부 업로드 v0 Drive archive(#499). 게이트 재확인 runtime-db+ios PASS, BUILD_TICKETS 충돌은 main 완성본 채택. ADR-0122 음성 양 클라이언트 완성 + 파일저장 서버 절반 실물(실 Google smoke 검증).
- clean slate: main=track/engine=bd77fe5. track/uxui는 UX 세션 작업 중(미커밋 19, 트랙 워크트리 — 파이프라인 정착). ENGINE_HANDOFF A-6(파일첨부 UI) 해제됨.
- 다음 엔진 후보: B-2 검색 서버 FTS / C-2 Work 실 Codex 검증 / B-4 알림 음소거 계약.

## 2026-07-18 (Fable) · 성재 승인 main 머지 — clean slate `a2ec4fd`
- UX 464를 Fable이 마감(크롬 계약 상수 52/48 정합, 파생 스냅샷 14장 재기록, 더블클릭 줌 이식) → 342/342+macos-ui 게이트 PASS → **성재 명시 승인으로 track/uxui→main 머지**(TRACKS §3 첫 적용).
- clean slate: main=track/engine=track/uxui=a2ec4fd, 루트 clean, 성재 앱=uxui 트랙 빌드(빌드 원본 고지 관행 시작). 엔진(음성 V-1~3 포함)은 이미 main에 있었음.
- 다음: 양 트랙이 여기서 분기 — UXUI는 ENGINE_HANDOFF ready 5건 제안 루프, 엔진은 V-3b(iOS 허들)/회의록 v1/Work 실검증 등 후보.

## 2026-07-18 (성재+Fable) · 트랙 파이프라인 대전환 (docs/TRACKS.md 정본)
- 이원화(UXUI/엔진)·워크트리 작업·트랙 워크트리 빌드 확인·**main 머지=성재 명시 승인** 정본화. track/uxui·track/engine + ~/projects/momo-tracks/* 신설. AGENTS.md·CLAUDE.md에 최우선 규칙 삽입. ENGINE_HANDOFF.md 신설(ready 5건 시드).
- UX 464 리뷰: 자동승인 가드(reversible-only fail-closed) 양호, 루트 잔재의 더블클릭 줌 이식·통합 커밋. **머지 부적합 판정**: ChromeTests 계약 3건 실패+파생 스냅샷 15건 미기록 → track/uxui에 보존(main 보류), UX 마무리 요청. 루트 잔재는 stash 보관 후 루트 clean 복구.
- track/uxui는 main(V-3 허들 포함)과 병합 완료(STATUS만 충돌·양쪽 보존). 성재 확인용 앱은 uxui 트랙 빌드로 재실행(46cb58d).

## 2026-07-18 (Fable) · V-3 랜딩 — 채널에서 말 걸기(음성 UI) 실물
- `ad983ee`: macOS 허들 UI(헤더 시작/참가·배지·미니패널, livekit swift SDK 2.15.2). 파일스코프 계약 준수(MomoHuddle* 신규+헤더 최소). 블로커가 전방호환 선재결함(미지 이벤트 type이 스트림 종료) 발견 → Core에서 skip 처리 동반 수정.
- 게이트: huddle/Core 34 test PASS, 유일 실패=workspaceSearch full-suite flake(선재·V-3 무관) → DEVIATION+MOMO-472 분리 후 머지(411/412 선례).
- 루트 재오염: UX 세션이 또 루트 체크아웃에서 직접 편집(STATUS/Theme/MomoMacRootView 등 미커밋 다수) — §4.1 무접촉, 정본은 temp worktree 우회. 성재 재전달 필요.
- 잔여: V-3b(iOS 참가), V-3 실오디오 2클라 왕복(성재 협업), 회의록 v1/v2. 음성 배포는 도메인 결정(S-4와 동일) 후 V-2b(TURN).

## 2026-07-18 (Fable) · V-2 랜딩 — 음성 v0 서버·인프라 완성
- `5bab0d2`: compose huddle profile(옵트인·핀 v1.13.3)로 실 LiveKit 기동, V-1 JWT 실수락 검증(200/무효 401) PASS. 서버→JWT→실 SFU 전 구간 실물.
- 운영 사건: Docker Desktop 신규 pull 전역 불능(레지스트리 도달성 정상·기존 컨테이너 무영향) — 성재 재시작으로 해소. verifier pull 단계 무한대기 개선 후보(비차단).
- 다음: V-3(macOS 허들 UI — UX 트랙과 발급 시점 조율 필요), V-3b(iOS 참가). 회의록 v1/v2는 후속.

## 2026-07-18 (Fable) · V-1 랜딩 + iOS 실기기 E2E 완주
- 음성 V-1 `df18a6b`(huddle 스키마/수명주기/LiveKit JWT — verifier+runtime-db PASS). 게이트가 461 선재 결함(notifier 컨테이너 Linux Sendable) 검출 → #490 1줄 수정. 다음: V-2(compose LiveKit+TURN).
- iOS: 실기기 푸시 E2E PASS(STATUS 정본) + deep link 수정 `61e5cf3` 랜딩(실기기 재확인 [manual]). worker capacity 사망 2회 모두 커밋 보존 인수로 유실 0.
- 워크트리 47개 회수(PR MERGED 확인 기반). 오케스트레이터 실런이 잡은 잠복 결함 3종 기록: 렌더 편차/python 버전/컨테이너 Sendable — 전부 worker 환경 사각.

## 2026-07-18 (Fable) · ADR-0122 Accepted + 워크트리 대청소
- 성재 "ㄱㄱ"로 음성 허들 Accepted(D1 LiveKit/D2 임시 허들/D3 3단계). V-1(MOMO-468 `#486`) 발급 — 서버 전용, UX 무충돌.
- 워크트리 50→5 회수(47개 — GitHub PR MERGED 확인 후만 삭제, dirty 4개는 §4.1 무접촉 보존). UX 세션은 relay 후 worktree 분리 안착 확인(활성: /private/tmp/momo-464).
- iOS: MOMO-467(등록 env 자동판별+os_log 관측) 랜딩 `37480d2` — 실기기 재검증(케이블 Run)은 성재 [manual] 대기.

## 2026-07-17 (Fable 엔진 트랙+성재) · S-4 v0 + P-3 PushRelay 랜딩 — 성재 개입 3건 전부 종결
- MOMO-460 `69ace59`(services/LinkShort — /i/<code>→302, 도메인은 DNS만 붙이면 됨) + MOMO-461 `94b62bc`(relay/PushRelay — Ed25519 등록제·rate limit·APNs ES256 발송, NotifierWorker 서명 옵트인).
- APNs 자격증명: 기존 개인 유료 계정 키 4SSR3XS7WZ(Team YWQQFQM38J) 재사용 — 실 smoke 2단: 자격증명 단독(400 BadDeviceToken 판정) + relay 경유 end-to-end(apns_id 발급 passthrough). .p8은 ~/.momo-secrets/(레포 밖).
- ADR-0120은 P-4(iOS)만, ADR-0121은 도메인 결정만 잔여. rebase 시 Makefile/local_gate 양측 신규 패키지 합집합 병합 전례 기록(regex 일괄 금지 — 앵커 삽입으로).

## 2026-07-17 (Fable 엔진 트랙+성재) · Drive 실 SA smoke PASS — 경로 C 전 구간 종결
- 성재가 런북 §2~§5 수행(GCP momo-dawn, SA momo-archive, 공유 드라이브 0AHKTseTvG-mpUk9PVA). 관문 2개 실측 기록: ①Google secure-by-default 조직 정책이 SA 키 발급 차단 → 프로젝트 한정 재정의(legacy+managed 둘 다) ②조직 정책 관리자 역할 선행 필요.
- 오케스트레이터 smoke(§7.1): drives.get/files.list/changes.startPageToken 3종 200. scope 실증 — drive.file 403 → drive.readonly 확정(GoogleDriveSABackend 기구현과 일치, 코드 무변경). 키 바이트 무출력·레포 밖 보관.
- 남은 성재 결정 2건 유지: S-4 단축링크(momo.app), P-3 푸시(.p8 대기 — 개인 유료 계정 확인됨).

## 2026-07-17 (Fable 엔진 트랙) · MOMO-459 openapi 플러그인 표면 + SA smoke 대기
- `c109043`: 플러그인/webhook/Drive MCP 25 paths·30 operations 명세, 라이브 대조 41/41 PASS. 리뷰에서 expires_at_ms 오배치 교정(선재 approvals drift 동시 마감). 미기재 표면 목록은 PR #469 본문에 보존(후속 문서 티켓 후보).
- Drive 실 SA smoke: 성재에게 GCP 단계 안내 전달 완료(런북 §2~§5) — Workspace 유무 확인 대기, 산출물 계약 = SA 키 파일(~/.momo-secrets/) + 공유 드라이브 ID.
- ADR-0121 잔여는 성재 결정 대기: S-4 단축링크(momo.app 도메인/호스팅), S-5는 ADR-0120 P-3(Apple Developer — 성재 개인 유료 계정 사용 가능 확인) 선행.

## 2026-07-17 (Fable 엔진 트랙) · MOMO-458 오피셜 라인업 마감
- `f9085dd`: Notion/Linear 왕복 검증(3-플러그인 정확 집합 + 개별 revoke 차집합) + 카탈로그 `recommended`(ADR-0113 D6 세트 {github, drive, external_webhook}) — 마켓플레이스 UI(#462)가 소비할 서버 계약 성립.
- 게이트 교훈 2건 환류: roundtrip verifier가 runtime-db 프로파일 미편입이었던 공백 마감, 게이트 PATH의 Xcode python3(3.9)가 adapter(slots=True, >=3.10)와 충돌 — verifier에 python 버전 명시 탐색.
- 오피셜 5종 전부 실물 검증 완료. 남은 후보: Drive 실 SA smoke(성재 GCP 수동), ADR-0121 온보딩 잔여, openapi 플러그인 표면 문서화(예약).

## 2026-07-17 (Fable 엔진 트랙) · SE-04D Drive 경로 C MCP v0 랜딩
- MOMO-457 `367442c`: momo-hosted read-only Drive MCP(`/v1/mcp/drive`) — tools/call마다 FOR SHARE grant 재검증+같은 tx audit, stub prod 부팅 거부, validator hosted 확장(외부 HTTPS 규칙 무손상), migration 015(자격증명 무저장). 리뷰 소견: 백엔드 호출 tx 내 실행(15s 유계) 후속 개선 후보.
- 오케스트레이터 후속 수정 2건: verifier rg 의존 제거, registry verifier 시드 4→5(전수 열거 단정이 의도대로 회귀 감지). 실런 verify_drive_mcp + runtime-db 게이트 PASS.
- 오피셜 라인업 현황: GitHub(등재+왕복)·webhook·Drive(hosted) 실물, Notion/Linear 등재만. 다음 후보: Notion/Linear grant 왕복 복제(소형) 또는 실 SA smoke 런북 evidence(성재 GCP 손 필요) 또는 ADR-0121 온보딩 추천 세트 합류.

## 2026-07-17 (Fable 엔진 트랙) · SE-04C 완주 + 게이트 자급 + dev 키체인 우회
- 3건 랜딩(전부 codex worker 구현→Fable 리뷰·게이트·머지): MOMO-449 `9b20692`(SE-04C grant→tool policy 왕복, 실런 verifier+registry 회귀+runtime-agent 게이트 PASS) · MOMO-450 `b835e76`(macos-ui 게이트 스택 자급, §9 거부 실증 포함 3박자 검증) · MOMO-452 `65a55ba`(dev 키체인 우회+dev-password 자동 채움, 성재 결정).
- ADR-0113 파생 체인 SE-04A→04B→04C 닫힘. 다음 파생: Drive 경로 C MCP 포장.
- 루트는 UX 세션이 codex/457 브랜치+미커밋으로 점유 — §4.1 무접촉, 정본·앱 랜딩은 임시/app-landing worktree 우회. UX 세션에 §4.1-4(worktree 이동+루트 정리) 재전달 필요.

## 2026-07-17 (Fable 엔진 트랙) · MOMO-448 사후 리뷰 수정 랜딩 + 루트 규약 정본화
- #448 사후 리뷰(코드+design 독립 2축, 둘 다 Blocker 0) → 합의 결함을 MOMO-448(#449)로 티켓화, codex worker(5.6 sol medium) 구현 → PR #450 리뷰 PASS → 게이트 → squash `df0bc00`.
- 게이트 실패 2건 해소: ①worker 셸 폰트 렌더 편차로 스냅샷 21장 게이트 환경 재기록(교훈: 캐노니컬 RECORD는 오케스트레이터 몫 — worker 프롬프트 계약에 명시할 것) ②macos-ui 프로파일에 `make up` 부재(선재 공백, 소형 티켓 후속 필요).
- GPT의 루트 stash 검증: stash@{0,1} 전 파일이 과거 커밋 blob과 일치 — 유일본 0, mixed-reset 착시 확정. §4.1-5 정본화(루트 항상 clean, `pull --ff-only`만, dirty 위 mixed reset 금지, `8202aef`).
- DEVIATION_LOG 스냅샷 drift pending → accepted 종결(#448+#450). 다음: ADR-0113 후속(GitHub grant 왕복→Drive 경로 C), macos-ui 프로파일 보강 티켓.

## 2026-07-16 (momo-main/GPT 5.6) · PLN-20260716-01 Plugin Platform productization
- Codex/Hermes/MCP와 Google Workspace·GitHub·Notion 공식 표면을 대조해 plugin package와 runtime adapter를 분리했다.
- Plugin Center/추천 onboarding과 catalog/install/connection/channel/grant/health 독립 projection, Capability Cache 기반 동적 discovery를 제품 제안으로 정리했다.
- Drive selected-file read/cite/upload/link는 첫 vertical 후보이며 기존 GitHub-first 전략을 대체하지 않는다. 성재 결정+Accepted ADR 전 구현 순서 변경 금지.
- 보안 리뷰를 반영해 subject/actor/delegation binding, remote runtime SSRF 경계, Drive create outcome-unknown, webhook ingress/executor 분리를 Fable handoff에 추가했다.
- 다음: Fable이 ADR-0113/SE-04A 옵션과 threat model을 정교화한 뒤 성재가 선택한다. builder issue는 그 이후다.

## 2026-07-15 (Codex worker) · MOMO-392 channel chrome/context navigation
- compact one-line header, unifiedCompact chrome/inset, header-right app Downloads, truthful search-unavailable, channel quick/context/keyboard/VoiceOver actions를 구현했다.
- standard 1180x760, narrow 980x620, wide 1800x900 실창과 Downloads/search state, light/dark artifacts를 `/tmp/momo-398-design/`에 기록했다.
- MOMO-386 search backend와 chat attachment downloads/notification engine은 구현하지 않고 UI에서 planned/unsupported로 명시했다.
- 남은 것: full tests/preflight/local gates/fresh design review → commit/push/PR → `status:needs-review`; worker는 merge/close하지 않는다.

## 2026-07-17 (Fable, 오케스트레이터) · ADR-0115 Accepted → SE-04B/411 착수 + worktree 소유권 사고
- ADR-0115 Accepted(성재) → MOMO-412 `#438`(SE-04B webhook+Slack-호환)·MOMO-411 `#436`(gate 리소스 가드) codex worker 2기 병렬 spawn(§9 부하 체크: load 10.9, 412만 실질 부하 — 규칙 내).
- **worktree 소유권 사고(3번째 크로스 세션 파일 사건)**: 통합자가 메인 worktree의 GPT UX 작업분(MessageListView+launcher)을 stash 시도 → 성재가 차단. 판별 결과 GPT는 #437을 격리 worktree에서 정상 머지했고 메인 worktree 사본은 다른 버전(잔재 추정, 단 확정은 GPT 세션 몫 — 무접촉 유지). 내 커밋은 임시 worktree cherry-pick으로 push 우회.
- **§4.1 메인 worktree 소유권 규칙 정본화**: 메인 체크아웃=docs/머지 전용, add -A 금지, 타 세션 미커밋 파일 무접촉(stash/reset 금지), push 충돌 시 임시 worktree 우회, 초안 잔재는 만든 세션이 정리.
- 주의 인계: 메인 worktree의 STATUS.md/Theme.swift도 구버전 스냅샷 — GPT 세션이 잔재 정리 전까지 통합자 플러시는 임시 worktree 경유.
- 다음: 438/436 PR 검수(§9 부하 규칙 아래 게이트) → 순차 머지.

## 2026-07-17 (Fable, 오케스트레이터) · MOMO-411/412 종결 — 리소스 가드 + webhook ingress
- MOMO-411(`710a069`)·412(`5ff5161`) 순차 머지. 411=gate --down+부하 체크(발열 사고 봉합, teardown 잔재 0 실증), 412=ADR-0115 signed webhook + Slack-호환(리뷰 H1로 미지원 필드 무시 전환 — Grafana/Alertmanager URL 교체 동작). codex worker 2기 병렬, 오케스트레이터 검수·게이트·머지.
- 사고/해프닝 3건 무손실 처리: ①메인 worktree UX WIP를 임시 worktree cherry-pick 우회로 무접촉 push(§4.1 정본화) ②PR #439 GitHub mergeable-UNKNOWN 오작동 → 재오픈 후 정상 머지 ③rebase STATUS 반복 충돌 → origin 정규화. verifier 단정 오류 2건(201·토큰 매칭)은 H1 반영 케이스의 실수로 서버 무관, 수정.
- macOS 스냅샷 FAIL은 origin/main HEAD 격리 재현으로 UX 트랙 선재 확정 — 두 게이트 모두 이 사유로 무한 대기 없이 서버 표면 실증(단독 verifier)으로 머지 판정.
- 다음: ADR-0113 후속(GitHub grant 왕복→Drive 경로C). M1/M2·MOMO-390 smoke 등 DEVIATION_LOG pending 정리. UX 스냅샷 drift는 UX 트랙 통보 필요.

## 2026-07-17 (Fable, 오케스트레이터) · 리소스 거버넌스 정본화 + ADR-0115 draft
- 성재 지시로 부하 규칙을 프로젝트 정본화: `MULTI_SESSION_OPS.md` **§9 Resource Governance**(부하 체크 게이트 load>12 금지/8~12 단일/`<8` 정상, 게이트 후 down 의무, 호스트 전체 heavy 동시 1개, 잔재 판별 팁) — 전 세션(Fable/GPT/Codex) 적용. tooling 봉합 MOMO-411 `#436` 발급(status:ready, 부하 안정 후 착수).
- 부하 모니터 가동(load<8 3연속 시 heavy 재개 신호). ADR-0115 Proposed 기안(문서 작업) — HMAC native 모드 + Slack-호환 URL-시크릿 모드(blocks v0 거부), SE-04B 계약 승계.
- UX 세션 전달 멘트 작성(성재가 GPT momo-main 세션에 전달) — §9 요지 + UX 해당 항목.
- 다음: 성재 ADR-0115 승인 + 부하 안정 → SE-04B·MOMO-411 codex-fleet 발급. UX 트랙 점검은 추후 일괄(성재 지시).

## 2026-07-17 (Fable, 오케스트레이터) · SE-04A 종결 + 발열 사고 진단·방지 계약
- MOMO-410(PR #435 `1809551`) 종결 — 플러그인 물리 기반 랜딩. 리뷰 H1/M1/M2 반영, plugin verifier+runtime-db PASS. 크로스트랙 오커밋 사고(add -A → main macOS 빌드 파손)를 e1a9b78 revert로 수습, UX 작업분 보존.
- **발열 과부하 진단(성재 발제, Opus 세션 병행)**: 원인 절반=정상 동시부하(tf-hwp+momo 2트랙+VM 콜드빌드), 절반=구조 결함 — ①runtime-db 게이트의 `make up`이 스택을 내리지 않아 게이트 런마다 postgres+centrifugo 잔재 생성(주 생성자=이 세션의 오케스트레이션) ②게이트 중첩. 조치: 유휴 스택 5벌 down(활성 433·momo_main 보존), builder 2.5GB+볼륨 5.6GB 회수.
- **재발 방지 계약(오케스트레이터 의무)**: ①게이트 런 종료 즉시 해당 compose project down ②docker-heavy 게이트 직렬화(동시 1개) ③배치 종결마다 janitor+prune, 주 1회 reclaim --aggressive ④무거운 병행 작업 시 worker 동시 수 1-2 제한. tooling 후보: local_gate.sh `--down` 플래그(티켓 발급은 머신 안정 후).
- 다음: ADR-0115(signed webhook+Slack-호환 모드) draft → SE-04B. 무거운 게이트는 머신 부하 확인 후 실행.

## 2026-07-17 (Fable, engine planner+오케스트레이터) · ADR-0113 Accepted → SE-04A 착수
- 성재 승인("ㄱㄱ")으로 ADR-0113 Accepted 전환. UX 트랙은 GPT Codex 앱 진행분 팔로업만(MOMO-402 머지·409 발급 관찰 — 개입 없음, 추후 일괄 점검 형식).
- SE-04A=MOMO-410 `#434` 발급(수용기준+패킷 `2026-07-17-adr-0113-se04a-plugin-registry.md`) → codex worker(5.6 sol medium) spawn. registry 스키마(013)+validator fail-closed+install/grant/revoke REST+Capability projection+오피셜 시드 3종(GitHub/Notion/Linear).
- 사고 1건 자가 복구: `git add -A`가 UX 트랙 미커밋 작업분(MomoComposerActionLauncher.swift)을 오커밋 → 인덱스만 revert(working tree 보존, `9ade613`). **교훈: 메인 worktree는 UX Codex와 공유 — 이후 명시적 파일 지정 add만.**
- 다음: 410 PR 검수·머지 → SE-04B(Slack-호환 webhook, ADR-0115 draft 병행 필요) 발급 판단.

## 2026-07-16 (Fable, momo-main 오케스트레이터) · MOMO-408 종결 — H1 노출 확장 봉합
- PR #431 머지(`8193734`). 독립 리뷰가 H1(owner만 잠그면 pre-MOMO-217 join 행 잔존 노출)·H2(로컬 도그푸드 루프 파손 미기재)를 잡음 → planner 처분: 잠금 전 human 확장 + 로컬 러너 명시 부트스트랩(철학 일치). 오잠금 가드 매트릭스 verifier 추가, seed verifier 4/4 PASS.
- 전체 runtime-db 재실행 2회 외부 중단(SIGTERM) → 등가 논증으로 대체(수정 전 전체 PASS + 델타 3파일이 게이트 비대상/단독 검증 완료 — PR 코멘트 정본). 한가한 시점 전체 1회 재확인 권장.
- 후속 후보: INTERNAL_ALPHA/RUN dev-password 안내 정비(M2), regenerate 404/409 분기(L1 from #428).
- 대기: ADR-0113 성재 option 승인(→ SE-04A codex-fleet 발급), MOMO-402/405 등 UX 트랙 관찰 지속.

## 2026-07-16 (Fable, engine planner+오케스트레이터) · ADR-0113 기안 + MOMO-408 발급
- 성재 지시(플러그인 우선순위 상향·오피셜 집중·Slack/MM 호환)로 3축 분배: ① MOMO-408 `#430`(prod 시드 fail-closed, H1 파생) codex worker 가동 ② 실검증 리서치 2건 완료 — **16-03: Google 공식 Workspace MCP 존재(2026-05 Preview, 배포자별 GCP 필수), GitHub/Notion/Linear 전부 remote+DCR 위임 가능** / **16-04: Slack 호환의 실체=와이어 포맷뿐, MM incoming webhook 선례 검증, MM 플러그인 바이너리 기각 확정(Apps Framework 철회가 반면교사)** ③ **ADR-0113 Proposed 기안** — custody A(호스트=클라이언트+remote 우선), delegation 4-튜플, GitHub-first+Drive 경로C(SA 포장 — 동결 사유 우회), D4 Slack-호환 webhook(ADR-0115 입력), egress manifest 명시.
- 다음: 성재 ADR-0113 option 승인 → SE-04A부터 파생. MOMO-408 PR 대기 중.

## 2026-07-16 (Fable, momo-main 오케스트레이터) · ADR-0121 배치 1 종결 — codex-fleet 복귀
- 성재 지시로 구현 체제 전환: Fable 전담 → **codex-fleet(worker=gpt-5.6-sol medium)**. MOMO-406/407 병렬 spawn(stall 워치) → 둘 다 클린 완주 → 독립 리뷰 2건 병렬 → 반영(429: H1 시드 dev-password 경고+M1 rg 스킵 봉합, 428: M1 의미론+verifier casing) → 순차 머지(`bb3efc6`→`4a8b288`) → main 게이트 PASS.
- 검증 분담 계약 작동: worker=정적/swift, docker 게이트=오케스트레이터 — runtime-db 1차 실행이 verifier UUID strict 비교 결함을 실제로 잡음.
- 후속 후보: prod 시드 fail-closed 서버 티켓(H1 파생, 공개 배포 전 필수 성격), install fake-docker trace, regenerate 404/409 분기.
- 다음 잔량: S-4 universal link(웹), 리액션 REST(UX 조율), ADR-0122 승인 시 음성 V-1, 플러그인 위임(16-02).
- 종결 확정: main post-merge runtime-db가 verifier flake 2건(핸들 32자 상한 — pid 자릿수 의존)을 잡아 전수 감사로 봉합(`f460867`·`a23c261`), 3차 런 **PASS**(join 44 PASS). 배치 완전 종결.

## 2026-07-16 (Fable, 엔진/인프라 트랙 momo-main 겸임) · MOMO-404 종결 — ADR-0120 서버측 절반 완성
- P-2(PR #424 `a8a1089`) 종결. 후보 기록은 011 트리거(재량 행사 — 리뷰가 불변식 정합을 일회용 PG 재현으로 판정, overview.md에 "생산자 트리거 유일·신규는 ADR" 정본화). 리뷰 H1/M1/L1 반영 후 verifier 재PASS. stall 방지 계약(대기 전 push)이 처음으로 완전 작동.
- ADR-0120 잔여는 Dawn 운영 결정 대상: P-3(PushRelay 실발송 — Apple Developer 계정+relay 배포), P-4(iOS/M5). 후속 후보: push_candidate prune(L3), D2 필드 목록 ADR 반영(L2).
- 다음 후보(성재 신호 대기): ① ADR-0121 S 배치(install.sh — 배포판) ② 리액션 서버 REST(15-04, UX 트랙 조율) ③ ADR-0122 승인 시 음성 V-1 ④ 플러그인 위임(16-02). 엔진/인프라 트랙의 발급 가능 잔량은 이 4개.

## 2026-07-16 (Fable, 엔진/인프라 트랙 momo-main 겸임) · MOMO-403 종결 + 크로스트랙 정리
- ADR-0120 P-1(MOMO-403, PR #422 `36c0d70`) 종결 — device 등록 REST + migration 010(단일 ACTIVE 토큰 DB 강제). 구현 에이전트 stall을 통합자가 인수(verifier 재실행 PASS→push/PR), 독립 리뷰 Medium(TOCTOU)을 RETURNING 원자 재검증으로 봉합 후 verifier 반영본 재PASS. runtime-db 프로파일에 verifier 편입.
- 푸시 배치 발급: MOMO-403 `#420`/404 `#421` + 패킷(2026-07-16-adr-0120-push-server-side.md — id-only 하드 계약·outbox 소비자 경합 방지·MOMO-395 설정 표면 경계).
- 크로스트랙: GPT momo-main 복귀 관찰(MOMO-402 `#418` 머지·plugin overlay). PLN-20260716-01 중복 레인을 한 행으로 병합, momo-main 지정 구체화 4항목(custody/Drive-vs-GitHub/delegation binding/egress)을 16-02 핸드오프에 승계. 유령 스택 정리 2회(성재 승인).
- 다음: MOMO-404 NotifierWorker 착수(unblock 완료) → 리뷰/머지로 ADR-0120 서버측 절반 완성. P-3(relay 실발송)는 Dawn 운영 결정 대기.

## 2026-07-16 (Fable, 엔진/인프라 트랙 momo-main 겸임) · MOMO-401 종결 — 웹 v0 완주
- MOMO-401(PR #419) 머지(`9616c67`)로 ADR-0119 웹 v0 7티켓 완주. 구현 에이전트는 stall이 아니라 콜드빌드 3런의 장주행이었고(총 4h, 게이트 경화 2커밋 자가 산출), PR 선생성·리뷰 M1/L1 반영은 통합자가 수행. 독립 리뷰 Blocker/High 0.
- join=스펙 준수 즉시 세션(JoinResponse required 토큰), 초대 코드 비잔류, 오류 카피 서버 문자열 대조. 스모크 32 PASS.
- 다음: 푸시 P-1(device 등록 REST)/P-2(notifier) 발급이 자연 후속. ADR-0122(음성)·플러그인 16-02 위임은 성재 신호 대기. UX 트랙(momo240_38877 활동 관찰)과 파일군 충돌 없음 유지.

## 2026-07-16 (Fable, 엔진/인프라 트랙 momo-main 겸임) · MOMO-400 종결 + 플러그인 플랫폼 리서치
- MOMO-398(`#413`)/399(`#412`)/400(`#414`) 순차 머지. 400은 stall된 수정 에이전트를 통합자가 직접 인수 — 남겨진 의도적 누출을 강화 단정이 DOM 레벨 검출(음성 대조 실증), 최종 스모크 25 PASS/0. 유령 게이트 스택 5벌 정리(janitor+수동, momo_main 보존)로 OOM 재발 조건 제거.
- 성재 발제(플러그인 플랫폼, 1호 Drive)로 PLN-20260716-01 claim → `research/16-plugin-platform/` 00(생태계: 3층 표준 수렴·커스터디=클라이언트 문제·원클릭의 실체)·01(제안: 기존 ADR-0113→SE-04A 큐의 제품화, Drive 모드A는 동결 트랙 우회 첫 slice)·02(Fable 엔진 세션 핸드오프) 랜딩. 구현 없음 — 문서화만(성재 지시). hang된 하위 리서치 2기는 shutdown, 몫은 02의 1순위 검증 목록으로 승계.
- 다음: MOMO-401 `#411` unblock·착수(웹 v0 마지막) → 푸시 P-1/P-2. 플러그인은 성재가 02를 별도 Fable 세션에 위임. UI handoff(Codex) 도착 시 01 §5와 대조.

## 2026-07-15 (Fable, 엔진/인프라 트랙 momo-main 겸임) · 웹 첫 배치 3/3 종결 + 후속 발급
- MOMO-391(PR #407) 독립 리뷰 Blocker/High 0·Medium 1(만료 access 로그아웃 revoke) → 수정 반영(b499d32, 스모크로 서버측 revoke 실증) → merge `63e7d51` → main `--profile web` 전체 게이트 PASS. 웹 첫 배치(389/390/391) 종결, STATUS/BUILD_TICKETS evidence 정본화.
- 후속 발급: MOMO-398 `#408` prod Centrifugo allowed_origins(웹 W-4/W-5 선행 필수), MOMO-399 `#409` staging smoke namespace drift(DEVIATION_LOG 항목 `accepted` 판정).
- 크로스트랙 관찰: UX momo-main 재개 — PR #406(MOMO-385) 머지, MOMO-392~397 이슈(#398~#405) 발급됨. 겹침 정리: 스레드 REST 제안(15-04)은 MOMO-393에 흡수(중복 발급 안 함), 리액션은 MOMO-393 Out of scope라 미결(조율 대기), MOMO-394 첨부·MOMO-395 presence는 각각 파일 동결 계약(ADR-0113/0116)·ADR-0104 큐와의 정합을 UX momo-main과 확인 필요.
- 다음: 성재 신호 시 MOMO-398/399 Fable 에이전트 착수 → W-4/W-5 + 푸시 P-1/P-2 발급. ADR-0122(음성) 승인 대기 유지.

## 2026-07-15 (Fable, 엔진/인프라 트랙 momo-main 겸임) · 웹 첫 배치 389/390 머지 + 음성 ADR + 스키마 점검
- 성재 지시로 이 트랙은 Codex 대신 Fable 구현·검수 체제로 전환. MOMO-389(PR #404)/390(PR #403)을 Fable 에이전트가 worktree 구현 → 독립 리뷰(각각 Blocker/High 0, 게이트 독립 재현) → local_gate.sh 충돌 해소 후 순차 머지(`6fe746f`→`5ecd645`). 리뷰 후속(391 수용기준 web_serving_smoke 포함, GATE_PASSWORD 랜덤화, CSP 주석, spec-first 문구)과 STATUS evidence 반영.
- 스레드·리액션 점검(성재 질문): 둘 다 스키마 day-1 완비, REST/UI만 미구현 — `research/15-04`. 음성 허들 리서치 완료 → ADR-0122 Proposed(`LiveKit + 임시 허들 + 요약=agent_run Work`, 15-05) — 성재 승인 대기, Accepted≠즉시 착수.
- 선재 발견 gate drift(staging smoke ↔ agentwork namespace)는 DEVIATION_LOG `pending`.
- 다음: MOMO-391 `#397` unblock·Fable 에이전트 착수 → 리뷰 → 머지. 이후 W-4/W-5 + 푸시 P-1/P-2 발급. ADR-0122와 리액션/스레드 REST 티켓화는 성재 판단 대기.

## 2026-07-15 (Fable, 엔진/인프라 트랙 momo-main 겸임) · ADR-0119~0121 Accepted + 웹 첫 배치 발급
- 성재가 세 ADR 권고안을 전부 승인(AskUserQuestion 기록)했고, 이 트랙 한정 Fable의 momo-main 겸임(티켓·패킷·Issue 발급)도 승인했다. ADR 3건 Status를 Accepted로 전환.
- MOMO-389(OpenAPI 계약 정본+drift 게이트)/390(Caddy APP_DOMAIN+정적 서빙)/391(clients/web 스캐폴드) 수용기준을 BUILD_TICKETS에 등록하고 ready 패킷 `2026-07-15-adr-0119-web-track.md`를 발급했다. ROADMAP §1.6 플랫폼 확장 overlay 신설.
- 경계: UX 트랙(`clients/macOS/**`, MOMO-385/386)과 파일군 분리 유지. 웹 검증은 e2e compose(로컬 러너 수명주기 이슈와 무관). P/S 배치는 웹 배치 랜딩 후.
- 다음: GitHub Issue 발급(389/390 ready, 391 blocked) → 패킷 binding 갱신 → worker spawn은 성재 신호 대기.
- 성재 위임(엔진/인프라 트랙, 웹 우선 확정)에 따라 ADR-0119(웹 클라이언트 트랙), 0120(푸시 relay+notifier), 0121(배포판·초대 온보딩)을 Proposed로 기안하고 CURRENT_STATE 레인을 claim했다. base: MOMO-384 머지 후 main `b720250`.
- 웹 핵심 결정 제안: 같은 오리진 서빙(APP_DOMAIN site+`/v1` proxy — CORS 원천 회피, 서버 무변경), Vite+React+centrifuge-js, v0 토큰은 메모리+localStorage(공개 배포 전 httpOnly 승격 게이트), 수기 OpenAPI 정본+drift 게이트, v0 스코프="초대받은 사람이 브라우저로 합류해 대화".
- 코드 사실 대조: CORS/쿠키 코드 0건, login=body 베어러+회전(DTOs.swift:41-58), Caddy 2-site. UX 트랙(MOMO-385/386, clients/macOS)과 파일군 비충돌 확인.
- 다음: 성재 option 승인 → Accepted 전환 → 파생 배치(W/P/S) 티켓·패킷 발급(발급 주체는 momo-main 규약 — 겸임 여부 성재 확인 필요). 공용 정본(ROADMAP 웹 트랙 신설 등)은 승인 후 momo-main 통합.
- 성재 발제(이해도/슈퍼앱 수용성/인프라)를 받아 메신저 아키텍처 바이블 초판 6장(`docs/architecture/bible/`, 학습용 파생 등급)과 `research/15-platform-expansion/` 00~03을 랜딩했다. INDEX 등재, planning lane claim/갱신은 momo-main 자격으로 수행.
- 코드 대조 결론: 푸시/프레즌스/파일/웹훅은 "스키마·placeholder만 있고 경로 없음", 웹·리전은 완전 미예약, 그룹채팅은 기완비. 업계 결론: push relay는 Dawn 운영이 구조적 필연(id-only), 웹은 서버 동일 도메인 서빙, 멀티리전은 업계 전체가 비채택.
- 신규 ADR 후보 3건(α 푸시 relay, β 웹 트랙, γ 배포판·온보딩)과 기존 큐 입력(0104/0105/0113·0116/0115/0117)을 `15/03-decision-proposals.md`로 제안 — 번호 발급·우선순위·웹vs iOS 순서는 성재 결정 대기(§6).
- 다음: 성재가 §6 승인 시 ADR-α부터 draft 착수(0104 병렬 claim 가능). 바이블 07~10장은 해당 ADR 승격 후 집필.
- REST `members`/`channels`가 요청 시작 generation+workspace를 capture하고 reconnect 뒤 돌아온 이전 session 응답은 `CancellationError`로 폐기해 current cache를 건드리지 않게 했다.
- delayed A roster/channel → connect B → B cache load → A release race 2건을 deterministic URLProtocol gate로 고정했다. 전체 Swift count는 Core 24·Server 80·Relay 2·Worker 29·macOS 234 = 369.
- 이전 dirty-worktree gate evidence는 폐기한다. 새 final commit에서 dirty 허용 없이 runtime-db, 실제 launch macos-ui, docs를 실행하고 PR #389 handoff에 commit/evidence를 기록한다.
- 다음: PR #389 draft 유지, merge/close 금지, clean gate 뒤 momo-main final rereview.

## 2026-07-15 (Codex worker) · MOMO-383 final FAIL review actual fixes
- REST connect generation으로 delayed login→clear·overlapping A/B를 차단하고, channel/read/status subscription exact-token cleanup과 workspace identity+channels 병렬 bootstrap을 추가했다.
- workspace GET을 bounded one-query로 합치고 private migration drift exact-create/ACL, production external-role preflight, accessible retry color, narrow settings projection을 반영했다.
- Core 24·Server 80·Relay 2·Worker 29·macOS 232 = 367 tests; `runtime-db` 30/30(`…r7f86c3c71502`)와 실제 launch `macos-ui` 20/20(`…rfd90ac91063d`) PASS.
- 다음: PR #389 draft 유지, commit/push 후 momo-main final rereview. merge 금지; 후속 #390/#391/#392 유지.

## 2026-07-15 (Codex worker) · MOMO-383 fresh-deploy role-order P1 fix
- production migrate→role bootstrap 순서에서 migration 009의 conditional app grant가 건너뛰는 결함을 `bootstrap_roles.sql` app-only grant와 relay/worker explicit denial로 닫았다.
- ephemeral PG18 verifier가 runtime role 0개 → migrate → 여전히 0개 → bootstrap → app exact invite lookup allow, relay/worker deny를 실제 실행한다.
- static contract와 full `runtime-db` 30/30 PASS(`20260714T221124Z-…-r584776886194`), Swift 360 tests 유지.
- 다음: PR #389 draft 유지, 추가 commit/push 뒤 momo-main final rereview/merge.

## 2026-07-15 (Codex worker) · MOMO-383 final review fix 검증 완료
- 모든 bootstrap await/subscription·409 reload generation guard, authoritative-denial persistent cache 삭제, workspace root FORCE RLS와 locked-schema invite lookup, no-cache retry/AX 및 normalized settings를 반영했다.
- locked function은 app만 호출하고 PUBLIC/worker/relay/platform은 broad public function grant 뒤에도 거부됨을 `verify_rls.sh`와 실제 join smoke로 확인했다.
- Core 24·Server 79·Relay 2·Worker 29·macOS 226 = 360 tests; full `runtime-db`와 launch 포함 `macos-ui`, design preflight PASS.
- 다음: PR #389 draft 유지·momo-main final rereview/merge; 후속 MOMO-384 `#390`, MOMO-385 `#391`, MOMO-386 `#392`.

## 2026-07-15 (Codex worker) · MOMO-383 correctness/performance review fix
- stale workspace GET이 rename/new session을 덮지 못하도록 session/load generation + `updatedAtMs` guard를 추가하고, unknown error cache fallback은 default-deny, REST cancellation은 `CancellationError` 보존으로 고쳤다.
- Live demo cache scope를 제거하고 isolated UserDefaults 반복 bootstrap, race/session/cancellation/default-deny 회귀 6건을 추가했다. verifier는 apostrophe 이름을 `psql -v` stdin binding으로 audit하고 복원 GET까지 확인한다.
- `verify_channel_management.sh`, worker `swift`, `macos-ui` PASS. Core 24·Server 78·Relay 2·Worker 29·macOS 219 = 352 tests 0 failure.
- 다음: PR #389 draft 유지. #388 merge/rebase 뒤 momo-main full `runtime-db` + final rereview; 후속은 MOMO-384 `#390`, MOMO-385 `#391`, MOMO-386 `#392`.

## 2026-07-15 (momo-main/Codex) · MOMO-383 리뷰 반려 수정
- security/design 독립 리뷰에서 ADR 부재, cache auth leak, stale conflict, 모호한 오류/권한 문구와 verifier 복원 결함을 찾아 실제 수정했다.
- ADR-0118을 Accepted 결정으로 추가하고 cache를 server+member+workspace로 격리, 401/403/404 비노출, 409 자동 reload, 구 cache Codable 호환을 구현했다.
- workspace 설정은 validation/권한/충돌/연결 copy와 cached-name 재시도를 제공하고, sidebar subtitle은 현재 사용자 문맥을 표시한다.
- 전체 Swift Core 24·Server 78·Relay 2·Worker 29·macOS 212 = 345 tests 0 failure. 다음: final rereview → clean gates → PR/merge/root main.

## 2026-07-15 (momo-main/Codex) · MOMO-383 workspace-first 구현 검수
- toolbar workspace capsule을 sidebar 최상단 identity/native popover로 옮기고 owner/admin durable workspace rename API와 audit를 구현했다.
- ordinary member/cross-workspace 403, 두 client 영속 read, audit/restore, 표준·좁은 실창 기하는 PASS했다.
- icon/invite policy는 local draft, multi-workspace는 ADR-0117 전 금지, interactive Work command는 ADR-0114 전 금지 경계를 유지했다.
- 다음: fresh code/design review와 clean 3-gate 후 merge; 그 뒤 MOMO-384/385를 unblock한다.

## 2026-07-15 (momo-main/Codex) · PLN-20260715-01 workspace-first superapp shell
- 성재 실창 QA 12건을 workspace navigation, native channel sheet/tooltip, member inspector/one-click DM, RLS workspace search의 4개 builder로 분리했다.
- `Control+backtick`는 transcript drawer(MOMO-375)와 interactive Work Console을 분리하고, 후자는 ADR-0114 승인 전 구현 금지로 고정했다.
- multi-workspace는 ADR-0117 전 fake rail 금지, engine은 ADR-0113/0116 → 0114 → 0115의 planning-only queue로 분리했다.
- 다음: MOMO-382 docs gate/review/merge 후 MOMO-383을 첫 UX goal로 발급한다.

## 2026-07-14 (momo-main/GPT 5.6) · PLN-20260714-02 슈퍼앱 엔진 리뷰
- engine planner의 gap audit/proposal/handoff를 인수해 security review High 7/Medium 2, architecture review High 6/Medium 3을 반영했다.
- ADR-0113~0116을 예약하고 Memory/Capability, plugin/webhook, Codex bridge/real gate, GWS runtime/evidence/citation을 one-issue/one-PR 단위로 분할했다.
- MOMO-307은 강화 유지하고 MOMO-308은 non-claimable MCP umbrella(SE-03A/B/C 새 ID)로 전환했다. MOMO-310 advanced RAG, MOMO-320 env drift 전용, MOMO-321/322 후속 동결로 충돌을 정리했다.
- 다음: 성재가 ADR 권고를 승인하면 0113/0116부터 draft goal을 발급한다. engine PR은 기본적으로 macOS UX 잠금 파일을 건드리지 않는다.

## 2026-07-14 (momo-main/GPT 5.6) · MOMO-380 식별자·보안 경계 재정정
- 아래 `MOMO-380`은 GitHub Issue `#381` / PR `#382`의 제품 티켓 ID다. 로컬 기록 부재로 혼동될 수 있어 이 항목으로 식별자를 명시한다.
- upstream Codex/OpenAI 자격증명 비유입과 허용되는 Hermes-facing bearer를 분리하고, GWS token 저장은 Accepted ADR 전 연구 스펙으로 낮췄다.
- engine planner는 BUILD_TICKETS 정본을 직접 수정하지 않고 proposal 안에 변경안을 남기며, 완료된 ADR-0109 Wave 2의 stale 다음 행동도 제거했다.
- 다음: docs gate와 의미 재리뷰가 green이면 PR #382를 merge하고 root main을 최신화한다.

## 2026-07-14 (momo-main/GPT 5.6) · MOMO-380 의미 리뷰 반영
- 독립 리뷰가 provider 자격증명 경계 과잉 일반화와 Work 실런타임 검증 과장을 지적해, Codex/OpenAI 실행 토큰과 GWS connector 토큰 경계를 분리했다.
- Work는 코드·mock 검증 완료/실 Codex 승인 왕복 `runtime-unverified`로 정정하고, 완료된 362..365 중복 발급 행을 제거했다.
- `PLN-01`은 `waiting-owner`, `PLN-02`는 `queued/unclaimed`로 고쳐 planner claim과 구현 worker 역할을 분리했다.
- 다음: PR #382 재게이트·리뷰 후 merge; UX 육안 QA와 engine planning claim은 그 뒤 각각 진행한다.

## 2026-07-14 (momo-main/GPT 5.6) · Fable 인수 감사 + UX/엔진 두 트랙 고정
- main/origin `b5e572b`, 열린 PR 0을 확인하고 Fable의 ADR-0112 Wave A(370..372)+MOMO-379 실창 크롬 핫픽스 랜딩을 코드/BUILD_TICKETS/저널과 대조했다.
- 다음 UX는 373..378이 ADR 후보로만 존재하고 BUILD_TICKETS 계약·handoff·Issue가 아직 없으며, 최신 앱 육안 QA와 멤버 행 절단 판정이 선행이다.
- 엔진은 Work/승인/bearer/status/비용·감사는 구현됐고, Context Broker·MCP는 부분, GWS·plugin runtime은 스펙, webhook은 placeholder임을 CURRENT_STATE에 고정했다.
- 다음: `momo-main`은 UX 수동 QA(`PLN-20260714-01`), 별도 engine planner는 슈퍼앱 builder chain(`PLN-20260714-02`)을 제안하고 성재 승인 후에만 공용 정본/Issue로 통합한다.

## 2026-07-14 (momo-main/Fable) · MOMO-379 크롬 핫픽스 2차 랜딩 — 실측 반증→재수정 사이클
- 성재 스크린샷 3결함(타이틀 중복·패널 침범·배지 겹침) → 1차 수정은 리뷰 실창 AX 실측이 no-op 반증(SwiftUI가 SplitView 칼럼 safe area를 0으로 보고) → `contentLayoutRect` 기반 재수정 → 2차 실측 리뷰 PASS(3케이스 AX 확증). PR #380 merge(`cef7430`), root `macos-ui` green.
- 교훈 확립: 창 크롬 클래스는 스냅샷·코드 논증으로 부족 — 실창 AX 실측이 리뷰 필수 단계(D6). harness도 프로덕션 창 구성이어야 정본에 증거 능력이 생긴다.
- 이월: 멤버 행 이름 절단(기존, layoutPriority) 별도 티켓 후보.
- 다음: 앱 재빌드→성재 재확인 → Wave B/C 발사 판정.

## 2026-07-14 (Codex worker) · MOMO-379 실창 AX 재반려 수정
- 기존 safe-area 수정은 `NavigationSplitView` 칼럼에서 top=0인 no-op이었다. hosting `NSWindow.contentLayoutRect`를 flipped/non-flipped content 좌표로 읽어 sidebar/detail에 전파하고 overlay/attached를 보이는 채널 헤더에 앵커했다.
- production full-size+unified 전체 root를 쓰고 WindowServer 합성본만 canonical 기록하도록 하네스를 교체했다. dark headless 흰 캡슐은 비정본 `cacheDisplay` 합성 결함으로 격리하고 fixture는 `momo/상준`으로 고쳤다.
- 5패키지 build, Core 24·Server 76·Relay 2·Worker 29 전체, macOS non-snapshot 146와 MOMO-379 기능 10+artifact 1이 PASS(canonical 3 skip)했다. fresh D6는 구현 6/7(Blocker 0, High 1=실창 AX 증거)이다.
- 계획 이탈: Computer Use가 custom dev app을 거부하고 관리 shell에는 WindowServer/AX trust가 없어 worker 표준/좁은/attached AX 실측은 `runtime-unverified`; 오케스트레이터 재측정이 필요하다. DB/Docker/verifier/gate는 미실행했다.

## 2026-07-14 (Codex worker) · MOMO-379 창 크롬 핫픽스
- 두 app host를 공용 title-hidden unified toolbar로 고정하고, overlay/attached inspector를 live safe area와 측정 채널 헤더 아래로 제한했다.
- 계획 이탈: 의심된 승인 배지는 하단 고정 utility라 원인이 아니었고, 실제 빨간 겹침은 workspace header를 toolbar로 옮긴 뒤 top safe area를 잃은 첫 채널 mention 배지였다. 해당 sidebar 경로만 safe area를 소비한다.
- 5패키지 build, Core 24·Server 76·Relay 2·Worker 29·macOS non-snapshot 145와 MOMO-379 raster, fresh D6 review 6/7(Blocker/High 0) PASS. 무필터 macOS의 기존 headless `NSImage` signal 5와 Xcode nested sandbox 실패는 재현했다.
- 정본 3종은 오케스트레이터 재기록 대기, 실 Dev/Xcode click·fullscreen은 `runtime-unverified`. DB/Docker/verifier/`local_gate.sh`는 미실행했다.

## 2026-07-14 (momo-main/Fable) · ADR-0112 Wave A 종결 (370/371/372)
- merge: 370 `6f4090c`(Blocker 반려: dev 밀도 보존+조사 비문+비용 누출) → 371 `c9ed890`(High 4 반려 — 리뷰 A/B 프로브가 죽은 닫기 버튼의 실증 원인=타이틀바 밴드 규명, 본문 15pt) → 372 `e254cc6`(Blocker 반려: 빈 캡처+DM 검색·정렬·배지, 멤버 수→디렉터리 훅 통합). root full gate green(`…062029Z…`, `…062619Z…`).
- D6 SLA rubric이 첫 판부터 유효: 빈 스냅샷·리터럴 DM·크롬 원인 오기가 전부 리뷰에서 잡힘. canonical 재기록 총 21종(fixture 변경분은 삭제 후 기록).
- 다음: 라이브 앱 재빌드→성재 육안(기본 모드/헤더/디렉터리·DM) → 판정 후 Wave B(373..375: 호출 옵션·승인 프리셋·⌃` 드로어)/C(376..378: 대시보드·온보딩 여정·런치 WOW) 발급.

## 2026-07-14 (Codex worker) · MOMO-372 MOMO-371 최종 rebase
- `origin/main@c9ed890` 위로 직접 rebase하고 ChannelList/QuickSwitcher 충돌에서 371 로컬 rename·topic·인콘텐츠 헤더 제거와 372 DM 상대 이름·숫자 배지·디렉터리 진입점을 함께 보존했다. 문서 기록도 양쪽을 유지했다.
- 채널 헤더 `멤버 N명`의 optional action은 production root의 `MemberDirectoryView` sheet fallback으로 연결하고, 외부 주입 action 우선 계약과 회귀 테스트를 추가했다.
- 5패키지 build, Core 전체 24·macOS non-snapshot 전체 143·371/372 비정본 raster 7 tests와 fresh D6 design-review(Blocker/High/Medium/Nitpick 0) PASS. 무필터 macOS 전체는 기존 canonical `AgentCredentialSnapshotTests` headless `NSImage` signal 5에서 중단돼 재기록 대상으로 남겼다.
- 계획 이탈: 371/372가 서로 다른 뜻으로 추가한 `noWorkspaceMembers` 이름 충돌은 채널 추가 빈 상태와 directory 빈 상태를 별도 copy로 분리했다. PNG 변경 없이 정본 재기록은 오케스트레이터 대기이며 DB/Docker/verifier/`local_gate.sh`는 미실행(`runtime-unverified`).

## 2026-07-14 (Codex worker) · MOMO-372 D6 리뷰 반려 반영
- Blocker 1+High 3+Medium 3을 반영해 실제 검색/닫기/멤버 행 raster, ⌘K 상대 이름 검색, 표시 이름→ID DM 정렬, DM unread 숫자, 1줄 이름, 멤버 제목의 죽은 버튼 제거를 고정했다.
- 계획 이탈: visible `NSWindow` host는 XCTest signal 11, hidden system toolbar는 dark vibrancy smear라 list/detail을 borderless window에서 분리하고 동일 바인딩의 snapshot-only native capture chrome으로 증거화했다. 신규 정본 6건+기존 ChannelRoster 6건은 오케스트레이터 재기록 대기이며 PNG 변경은 없다.
- 5패키지 build, Core 24·Server 76·Relay 2·Worker 29·macOS 기능/비정본 raster 138 tests PASS. 무필터 macOS는 기존 headless `AgentCredentialSnapshotTests` `NSImage` signal 5를 재현했다.
- fresh design-review PASS: Blocker/High/Medium/Nitpick 0. 검색·닫기·멤버 행과 DM 버튼 제목은 source-pixel raster assert로, DM 상대 이름+unread 수는 light/dark sidebar raster로 고정했다.
- 수정 금지 기록: directory `.task` stale, 키보드 진입, raw `directMessageError`, in-flight 버튼 레이아웃. DB/Docker/verifier/`local_gate.sh`는 미실행(`runtime-unverified`).

## 2026-07-14 (Codex worker) · MOMO-372 멤버 디렉터리 + DM
- active workspace member 쌍을 정렬·해시해 멱등 생성하는 tenant DM REST와 Core/REST/in-memory 계약을 추가하고, roster 기반 macOS 멤버 디렉터리·프로필·DM 시작·사이드바 상대 이름/기존 unread 결합을 구현했다.
- 계획 이탈 없음. `schema_v0.sql`, 채널 헤더, 메시지 카드와 기존 정본 PNG는 건드리지 않았다.
- 5패키지 build, Core 24·Server 76·Relay 2·Worker 29·macOS 기능/비정본 래스터 134 tests와 fresh design-review 전 등급 0이 PASS했다. DB/Docker/verifier/`local_gate.sh`는 지시대로 미실행이며 RLS·동시성 런타임은 `runtime-unverified`다.
- 필터 없는 macOS suite의 기존 headless `AgentCredentialSnapshotTests` signal 5와 정본 light/dark PNG 재기록은 오케스트레이터 대기다.

## 2026-07-14 (Codex worker) · MOMO-371 MOMO-370 rebase
- `origin/main@6f4090c` 위로 직접 rebase하고 MessageListView/MomoMacRootView 충돌에서 371 헤더·통합 toolbar와 370 `showsCosts`·Alpha 개발자 gate를 함께 보존했다. 문서 기록도 양쪽을 유지했다.
- 개발자 모드 해제 시 닫힌 Alpha 상세가 재개방되지 않도록 presentation의 pane redirect를 분리하고 회귀 테스트를 추가했다. 비정본 renderer는 임시 NSWindow에서 native default action을 그려 light/dark 레이블 증거를 안정화했다.
- 5패키지 build, Core 23, macOS 기능 135·실행 가능 snapshot 39(정본 대기 2 skip) PASS; fresh design-review는 Blocker/High/Medium/Nitpick 0이다. 무필터/MessageBubble canonical은 기존 headless `NSImage` signal 5를 재현했다.
- 계획 이탈 없음. 정본 재기록·실창 검증은 오케스트레이터 대기이며 DB/Docker/verifier/`local_gate.sh`는 지시대로 미실행했다(`runtime-unverified`).

## 2026-07-14 (Codex worker) · MOMO-371 fresh review High 4/Medium 3 반영
- 런타임 A/B로 죽은 닫기 버튼의 원인을 surface stroke가 아닌 구 타이틀바 밴드의 콘텐츠 침범으로 정정했다. unified toolbar 수정은 유지하고 `allowsHitTesting(false)`는 방어로만 기록한다.
- 372용 optional directory 액션을 production session root까지 전달하고, 로컬 채널 표시값을 헤더·사이드바·퀵스위처가 공용 해석하며, row/message 본문을 15pt급 semantic role로 상향했다. 토픽 2줄, 프로덕션 sidebar snapshot, 저장 후 재편집 상태도 보정했다.
- 수정 금지 후속 기록: 채널 설정 키보드 경로, 영어 placeholder 톤, AppStorage 키 상수화.
- main의 MOMO-370 선랜딩 후 rebase·정본 재기록은 오케스트레이터 몫이다. DB/Docker/verifier/`local_gate.sh`는 미실행한다.

## 2026-07-14 (Codex worker) · MOMO-371 채널 헤더·macOS 크롬
- 채널 identity/주제/멤버 수/설정과 이름·주제·멤버·연동 시트를 구성하고 MOMO-372 디렉터리 closure만 노출했다. 워크스페이스 identity는 unified toolbar로 옮기고 상세 패널은 단일 열림/닫힘 상태로 고정했다.
- 계획 이탈: 사전 생성 worktree/branch와 `status:ready` 부재로 assignee/`status:in-progress`를 수동 반영했다. 서버 channel update 계약이 없어 이름/주제는 동기화 범위를 밝힌 Mac 로컬 표시값이며, webhook과 실제 디렉터리는 후속 계약/티켓 경계를 유지했다.
- 5패키지 build, Core 23/Server 73/Relay 2/Worker 29/macOS 비이미지 130 tests와 MOMO-371 raster가 PASS했다. fresh design-review는 전 등급 0, 무필터 macOS는 기존 headless `NSImage` signal 5를 재현했다.
- 정본 light/dark PNG와 실창 traffic-light/fullscreen/닫기 hit-test는 오케스트레이터 대기다. DB/Docker/verifier/`local_gate.sh`는 지시대로 미실행(`runtime-unverified`).

## 2026-07-14 (Codex worker) · MOMO-370 fresh D6 반려 수정
- dev Work 카드는 기존 `input.brief`를 복원해 실행 로그/결과 중복과 canonical 회귀를 해소했고, 표준 모드 Alpha Command Center 직접 표면·승인 연관 버튼·초대 fallback을 dev gate 또는 초대 안내로 정리했다.
- 마지막 한글 음절 종성 기반 이/가·을/를·은/는 헬퍼와 혼합 이름 테스트를 추가하고, 접힌 카드는 2줄·펼침은 전문+detail 무중복으로 바꿨다. 표준 ApprovalInbox 실데이터 raster도 추가했다.
- 계획 이탈 없음. 참고-only 후속으로 `local alpha` 캡션, 설정 토글 캡션 위계, 무의미한 `agentActivitySummary` switch를 기록하며 이번 PR에서는 수정하지 않았다.
- 5패키지 build, Core 23·Server 73·Relay 2·Worker 29·macOS 비이미지 130 tests, 기존 Work canonical 2종과 검토 raster 13종 PASS; fresh review 6.5/7, 전 등급 0. 신규 dual-density 정본 4종 재기록과 기존 headless `NSImage` signal 5는 오케스트레이터 대기다.

## 2026-07-14 (Codex worker) · MOMO-370 개발자 모드 + 메시지 이중 밀도
- 기본 off 개발자 모드/별도 비용 토글과 standard/developer 타임라인·Work·승인·사이드바·온보딩 게이트를 구현하고, 데모를 사람 언어 대화와 양 밀도 fixture로 재큐레이션했다.
- 계획 이탈: 오케스트레이터가 만든 worktree라 `goal_claim.sh` 대신 assignee/`status:in-progress`를 수동 반영했다. 수용기준의 전역 tool/비용/로컬 알파/세션 상세 숨김을 닫기 위해 의존 표면 `AgentPartialView`·metadata·`ApprovalInboxView`·`MomoServerSession`까지 수정했으며 371/372 소유 파일은 무접촉이다.
- 5패키지 build, Core 23·Server 73·Relay 2·Worker 29·macOS 비이미지 129 tests, 검토용 raster 18종, fresh review Blocker 0(55/70) PASS. 기존 headless snapshot signal 5와 실창 상호작용은 `runtime-unverified`다.
- 다음: 오케스트레이터가 신규 timeline standard/developer light/dark 정본 4종을 재기록하고 clean 실창 검수를 수행한다. DB/Docker/verifier/`local_gate.sh`는 worker 지시대로 미실행했다.

## 2026-07-14 (momo-main/Fable) · 성재 실사용 종합 피드백 → ADR-0112 기안·Accept + Wave A 스폰
- 성재 판정 "최악의 경험" — 실행 원장 과노출(비개발자 공포), 메신저 기본기 부재(디렉터리/DM/헤더), Codex 문법 부재(호출 옵션·승인 프리셋·⌃` 드로어), 첫인상 밋밋, 디테일 결함(타이틀바 겹침·죽은 닫기 버튼). ADR-0112로 성문화: **"하나의 타임라인, 두 개의 밀도"** — 기본=Slack, 개발자 토글=Codex 앱. 같은 날 Accept.
- 파생 MOMO-370..378 3웨이브. Wave A(370 듀얼 모드/371 헤더·크롬 결함/372 디렉터리·DM) 즉시 스폰, B/C는 A 랜딩 후. design-review rubric에 D6 디테일 SLA(죽은 컨트롤·크롬 겹침·잘린 텍스트=무조건 Blocker) 추가.
- 별건 처리: 에이전트 대시보드(D5)·온보딩 여정(D4)은 Wave C. swift-lsp 플러그인 검증 병용 예정.
- 다음: Wave A 랜딩 사이클 → 성재 육안 → B/C.

## 2026-07-13 (Codex worker) · MOMO-369 fresh design-review High 2 수정
- `.windowChrome` 표면 범위로 루트·사이드바·타임라인 fill의 safe-area bleed를 복원하고 bounded 카드·팝오버 chrome 순서는 유지했다. 오류 상태는 인증/불러오기/보내기/작업으로 분리했으며, send 재시도는 실패 요청의 `clientMsgId`와 에이전트 멘션 대상을 보존한다.
- 계획 이탈 없음. MOMO-368을 union rebase하되 온보딩 PR diff와 정본 PNG는 0건으로 유지했고, 5패키지 build, Core 23·Server 73·Relay 2·Worker 29·macOS 기능 127+비정본 래스터 6 tests와 fresh review(Blocker/High/Medium/Nitpick 0)가 PASS했다. 필터 없는 macOS suite의 기존 headless canonical signal 5는 오케스트레이터 재기록 대기다.
- 수정 금지 후속 기록: increased-contrast 팔레트, 승인 인박스 행/카드 그림자 누적, 진단 팝오버 이중 chrome, `sessionChrome == nil` 재로그인 no-op, DateFormatter 캐시, panel 토큰 의미 분화.

## 2026-07-13 (Codex worker) · MOMO-368 fresh design-review 반려 반영
- High 1: primary 라벨의 `onAccent` 강제를 제거해 비활성 창 표현을 시스템 `borderedProminent`에 위임했다.
- Medium 3: 실효 없는 접근성 변형 2종 산출을 제거하고, 네 필드 Enter를 현재 primary에 연결했으며, 필드 배경을 불투명 semantic 색으로 교체했다.
- 참고 기록(수정하지 않음): 비밀번호 placeholder 중복, `isPreviewFocused`, 영어 hero 칩, 영어 단일 `OnboardingInviteView`, 기존 영어 `sessionNotice`.
- 계획 이탈 없음. 5패키지 build, Core 23/server 73/relay 2/worker 29/macOS 비이미지 122 tests, snapshot 5(1 PASS+4 skip), fresh review 전 등급 0 PASS; 정본 PNG 4건은 오케스트레이터 재기록 대기(`runtime-unverified`).

## 2026-07-13 (Codex worker) · MOMO-368 온보딩/로그인 재구성
- 560pt 중앙 단일 구성, 입력 상태 기반 데모/로그인 primary 1개, 낮은 위계의 초대·Keychain·로컬 알파 채우기, Tab/Enter/Esc 및 오류·오프라인 복구를 구현했다.
- 계획 이탈: 없음. 최초 디자인 리뷰 Blocker 1(커스텀 field chrome 설명 부재)과 High 2(오프라인 복구·accent 불일치)는 네이티브 편집 동작 유지 설명, transport/auth 분류+직접 데모, 공용 tint로 해소했다.
- 5개 Swift 패키지 build와 Core 23/server 73/relay 2/worker 29/macOS 비이미지 122 tests, fresh design-review(Blocker 0/High 0/Medium 1) PASS; 기존 headless image snapshot signal 5는 재현됐다.
- 신규 정본 light/dark PNG 4건 재기록과 clean/root `macos-ui`는 오케스트레이터 대기다. DB/Docker/verifier/`local_gate.sh`는 미실행(`runtime-unverified`).

## 2026-07-13 (Codex worker) · MOMO-369 앱 셸 시각 폴리시 W3
- 양 스킴 3층 표면·타이포·motion 토큰을 앱 셸/타임라인/Work·승인/팝오버에 적용하고, 401 단일 재로그인 배너·subtle REST 칩·커서/날짜/멘션/capability 이월을 해소했다. 온보딩·스키마·정본 PNG는 무접촉이다.
- 계획 이탈: 사전 생성된 worktree/branch와 `status:ready` 부재로 `goal_claim.sh`를 재실행하지 않고 assignee/`status:in-progress`를 수동 반영했다. 제품 수용기준 이탈은 없으며 repo-wide pre-flight의 기존 fixed-font hit는 변경 파일 밖이다.
- 5패키지 build, Core/Server/Relay/Worker 127 tests, macOS 비이미지 120 tests와 W3 raster 5 tests PASS; fresh review는 raw Command Center 진단 High를 수정한 뒤 Blocker/High 0, Medium 1이다. 전체 macOS는 기존 headless NSImage signal 5, 정본 재기록과 금지된 DB/Docker/verifier/gate는 오케스트레이터 대기(`runtime-unverified`).

## 2026-07-13 (momo-main/Fable) · Work v0 + Wave 2 배치 종결 (362..367) + 라이브 반영
- merge 순서: 362 `2d5b2ad` → 366 `69facce` → 363 `44f8d35` → 365 `f5aba9f` → 364 `adf159f`(High 반려: 종결 run ephemeral 가림) → 367 `fd8eabe`(스펙 변경 ⌥⇧↑↓ `d9f4e68` + 364와 7파일 rebase는 worker 위임). root full gate 2종 green(`…075706Z…-ra6804669e978`, `…080432Z…-r6738c50ddf08`).
- 교훈: rebase union 해소 후 전 패키지 빌드 검증 필수(Theme/Core brace 유실 2건 수기 수리 전례), 실충돌 다수 rebase는 맥락 가진 worker에 위임이 정확.
- 라이브 반영: dogfood Centrifugo `allow_user_limited_channels` 패치·재기동, server/relay/worker 신 바이너리 재기동(구 프로세스 SIGKILL 정리), read-state 벌크 라이브 확인(201:2/202:6), 앱 재빌드(pid 73174).
- Work 데모 잔여 1: codex 에이전트 시드는 dogfood DB 직접 쓰기 거부(정책 일관) — 성재 opt-in SQL(scratchpad `seed-codex-agent.sql`) 후 credential 발급·codex-workbench 기동은 오케스트레이터 몫. 데모 워크스페이스 `~/momo-workbench-demo` 준비됨.
- 다음: 성재 육안(전체 UI+unread+Cmd+K) → codex 시드 → /work 실데모 → Phase A 운영 단계(GHCR publish·EC2).

## 2026-07-13 (Codex worker) · MOMO-367 rebase on MOMO-364
- `origin/main` `adf159f` 위로 rebase해 Work 카드·컴포저·`⇧⌘W`와 unread·mark-read·`⌥⇧↑↓` union을 보존했다.
- 5개 Swift package build, Core 23 tests, macOS 비이미지 116 tests와 MOMO-367 snapshot 클래스는 green이다.
- 필터 없는 macOS test는 main 기존 `AgentCredentialSnapshotTests`의 headless 1x/정본 2x `NSImage` fatal로 중단; 정본 재기록은 오케스트레이터 대기다.

## 2026-07-13 (Codex worker) · MOMO-367 review spec correction
- 계획 이탈: planner 승인(momo-main/Fable)에 따라 unread 순회를 macOS 텍스트 선택과 충돌하는 `⇧⌘↑↓`에서 Slack 문법 `⌥⇧↑↓`로 변경했다.
- BUILD_TICKETS 정본 문구 갱신과 신규 light/dark PNG 기록은 오케스트레이터 대기다.

## 2026-07-13 (momo-main/Fable) · UI Wave 1 종결 (358 랜딩) + Work v0·Wave 2 발급
- MOMO-358 랜딩: 리뷰 High(⌘1..9 서수 술어 ≠ 사이드바 표시 술어) 반려→공용 ordered source 공유+Cmd+K 토글(`b261aea`), 스위처 정본 4종 재기록·육안 확인, clean gate PASS, PR #356 merge(`5ac5fa9`) — **W1 종결(357/358/359)**. root runtime-agent PASS(`…20260713T050905Z…-r3cfb32a2aaf2.md`); root macos-ui는 이 정본화 커밋이 게이트 중 root를 dirty로 만들어 1회 FAIL(자충수) → 커밋 후 재실행.
- ADR-0111·0109 파생 배치 발급: 패킷 2종(agent-work-surface, ui-wave2-unread) + BUILD_TICKETS 362..367 수용기준. 선행 362(work run 계약)·366(read-state 계약) 스폰, 363/364/365/367은 선행 랜딩 후.
- 다음: root macos-ui 재실행 green 확인 → 362/366 랜딩 사이클 → 성재 육안(새 UI + Cmd+K는 라이브 앱 재빌드 필요).

## 2026-07-13 (Codex worker) · MOMO-358 fresh review fix
- 사이드바·퀵 스위처·`Cmd+1...9`가 non-archived 일반 채널→DM ordered source를 공유하게 하고 `Cmd+K` 재입력 닫힘을 추가했다.
- 후속 기록(이 PR 수정 금지): AGENT 배지 공용화, 패널 radius 14 분화, SF Symbol 혼용, 에러 원문 덤프 노출, viewport 높이 과소평가.
- 정본 light/dark PNG 재기록과 DB/Docker/verifier/gate는 계속 오케스트레이터 대기다.

## 2026-07-13 (momo-main/Fable) · UI W1(357/359)+Phase A(360/361) 랜딩 — 358만 잔여
- merge 순서: MOMO-360 `6980e64` → 361 `1c044e6` → 359 `6b75260`(Blocker 반려 1회: 복사 칩 `.opacity` 밖 상시 노출 → 수정 후 timeline+bubble 정본 재기록) → 357 `94e9244`(High 반려 1회: 멤버 mutation 비마우스 경로 → context menu 복원, Theme은 354 adaptive 토큰과 union). root runtime-agent+macos-ui full gate green(`…20260713T041003Z…`, `…20260713T041531Z…`).
- 게이트 운영 교훈: 워크트리 macos-ui는 compose 스택 필요 — 수동 `up`은 Centrifugo fingerprint 부재로 drift guard FAIL(→`MOMO_CENTRIFUGO_AUTO_RECREATE=1` recreate), verifier는 api 포트 비점유 필요(compose api/relay/worker stop 후 실행). worker capacity/스트림 오류 3회는 전부 세션 resume으로 복구.
- MOMO-358(Cmd+K, `#351`) 스폰 — W1 잔여 1건. 랜딩 시 W1 종결 → Work 배치(362..365)+Wave 2(unread) 발급 조건 충족.
- 다음: 358 랜딩 사이클, 라이브 앱 재빌드로 성재 육안 확인(새 사이드바·타임라인), Work/Wave 2 티켓 발급.

## 2026-07-13 (Codex worker) · MOMO-357 fresh review fix
- 멤버 context menu에 add/remove를 추가해 키보드·VoiceOver mutation 경로를 복원하고, workspace gear의 비가시 hit-test/accessibility를 차단했다. 개명 전 고아 snapshot PNG 2장도 삭제했다.
- 후속 기록(이번 PR 수정 금지): profilePresenceBadge의 "나" 추정 휴리스틱, 비적응형 white `subtlePanelBorder`, 앱 전역 radius scale 통합.
- 검증 후 같은 브랜치에 push하고 PR #355는 `status:needs-review`에서 유지한다. 신규 light/dark PNG 정본은 오케스트레이터 재기록 대기다.

## 2026-07-13 (Codex worker) · MOMO-357 UI W1 셸·사이드바
- `NavigationSplitView` 폭 토큰과 워크스페이스/채널/DM/멤버 계층, 하단 승인·개발 유틸리티, hover 멤버 액션, server-roster presence 숨김을 구현했다.
- 계획 이탈: repo 전체 design pre-flight는 티켓 밖 기존 view의 fixed font 41건을 반환한다. 변경 파일은 0 hit이며 MOMO-359 경계인 `MessageListView`/`MessageBubble` 등은 수정하지 않았다.
- 검증: macOS build, 비스냅샷 82 tests, light/dark raster 1 test PASS. 새 light/dark 정본 PNG는 reference-wait skip, 전체 snapshot은 기존 host signal 5로 오케스트레이터 대기(`runtime-unverified`).
- 다음: fresh design-review 후 worker PR handoff; 오케스트레이터가 정본 PNG 재기록과 clean `macos-ui` gate를 수행한다.

## 2026-07-13 (Codex worker) · MOMO-360 GHCR 이미지 발행
- api/relay/worker는 공용 Swift Dockerfile, migrate는 기존 source-checkout-free SQL/shell 전용 Dockerfile로 linux/arm64 GHCR 발행 계약을 추가했다.
- 계획 이탈: 핸드오프의 “4종 모두 swift-service.Dockerfile 기반”은 실행 파일이 없는 migrate에 적용 불가해 기존 전용 Dockerfile을 재사용했다.
- prod compose/env/preflight를 shared SHA tag·per-image digest rollback·migrate-first로 정렬했다. Docker/AWS/verifier/local gate는 미실행(`runtime-unverified`).

## 2026-07-13 (momo-main/Fable) · ADR-0111 기안 (Agent Work Surface, 성재 발제) + UI W1/Phase A 스폰
- 성재 발제: 메신저 내 업무·터미널·코드 작업(특화 에이전트 + codex 오픈소스 활용) → ADR-0111 Proposed 기안. Option A(BYOA 실행: momo 서버는 코드 실행 안 함, codex CLI=에이전트 호스트 엔진, sandbox→승인 티어 매핑, capability 배지 명시 선택) 권장.
- ROADMAP §1.4 overlay 추가, MOMO-362..365 예약(Accepted 전 발급 금지). ADR-0109(unread)도 같은 날 Proposed.
- UI W1(357 `#347`/359 `#348`)+Phase A(360 `#349`/361 `#350`) worker 4기 스폰, 358 `#351`은 357 랜딩 대기.
- 성재 판정(같은 날): **ADR-0111 Accepted (Option A=BYOA)** + **ADR-0109 Accepted**. Work 배치·Wave 2 모두 현행 배치 랜딩 후 발급으로 확정.
- 다음: 현행 goal 랜딩 사이클(348/349/350 PR 검수, 347 capacity-오류 resume 진행 중) → 종결 시 MOMO-362..365 + Wave 2 발급.

## 2026-07-13 (momo-main/Fable) · Phase 0 dogfood 무결성 배치 종결 (354/355/356)
- merge 순서: MOMO-356 `0a4bf37`(+오케스트레이터 python≥3.10 pin) → MOMO-355 `ac00ef3`(context verifier self-seed 반려 1회) → MOMO-354 `9ca9c93`(design-review High 2건 반려→profile gate+NSHostingView 캡처 수정, 정본 PNG 재기록 `6f00f05` 후 멤버 행+AGENT 배지 픽셀 육안 확인).
- root post-merge full gate green: `local-gate-runtime-agent-20260712T170955Z-…-rfc58973d57b9.md` + `local-gate-macos-ui-20260712T171443Z-…-r88f66c1ce253.md`.
- 발견: `cleanup-seeded-agents`는 102·103 동시 은퇴인데 앱 pairing은 기존 hermes 멤버 재사용이라 103 재생성 product 경로 부재 — 라이브는 REST 채널 멤버십 제거로 김인턴만 invite-gated 처리, full retire는 pairing 표면 후속 티켓 이후. design-review Medium 5건 BUILD_TICKETS 이월.
- 다음: 라이브 반영(김인턴 채널 제거→gateway env/plugin 갱신→재기동→앱 재빌드) 후 성재 육안 검증. 이어서 UI Wave 1 + ADR-0109 기안 + Phase A 티켓.

## 2026-07-13 (Codex worker) · MOMO-354 review fix — profile gate + roster pixels
- server-SoT에서 로컬 프로필 편집 버튼/컨텍스트 메뉴를 비활성화하고 서버 관리 안내를 표시하며, `applyLocalProfile`도 같은 경계에서 no-op한다.
- 계획 이탈: 최초 `ImageRenderer` snapshot이 `ScrollView/LazyVStack` roster 픽셀을 누락했다. `NSHostingView` 2x 캡처로 교체하고 light/dark `AGENT` accent pixel assertion을 추가했다.
- 검증: macOS build, 비스냅샷 79 tests, roster snapshot 3 tests(정본 대기 2 skip + pixel 1 PASS), Python static contract/design pre-flight, fresh design-review PASS(Blocker 0/High 0/Medium 0/Low 0). DB/Docker/verifier/gate 금지 유지.
- 다음: 같은 PR 추가 커밋 push. 정본 PNG는 오케스트레이터 재기록 대기.

## 2026-07-13 (Codex worker) · MOMO-354 real-server roster SoT
- 반영: REST backend fixture fallback과 이름 기반 agent 숨김을 제거하고 `/roster` active membership를 사이드바·멘션·작성자·agent realtime 구독의 공통 권위로 연결했다. login/join은 ADR-0110의 `realtimeWebSocketUrl`을 광고하며 앱 env보다 우선한다.
- verifier: 기존 marker/OID-owned DB·per-run UUID·대문자 CENT_CHANNEL·source digest·exit 96 경계를 보존한 채 roster/realtime discovery assertion만 추가했다.
- 검증: server 63 tests, macOS 비스냅샷 79 tests, 신규 snapshot 2종 reference-wait skip, Python no-DB contract, shell syntax/권한, design-review PASS(Blocker 0/High 0/Medium 1). Docker/DB/verifier/local gate는 금지 범위로 미실행(`runtime-unverified`).
- 다음: 오케스트레이터가 snapshot 2종 재기록과 clean `macos-ui` 후 PR을 검수하고 momo-main이 merge/root gate를 맡는다.

## 2026-07-13 (Codex worker) · MOMO-355 review fix — context verifier fixture
- 오케스트레이터 clean `runtime-agent`에서 context verifier가 seed-none DB의 human(…101)/Hermes(…103) FK를 migration seed에 의존한 누락을 확인했다.
- workspace·human·agent·target/other channel+seq·membership을 verifier-owned fixture로 추가하고, seed-none verifier의 고정 101/102/103 참조를 전수 점검했다.
- 계획 이탈: 최초 정적 계약이 migration mode/격리 경계만 확인해 context의 FK fixture 완결성을 증명하지 못했다. context fixture 조각을 contract test에 추가했다.
- 다음: shell/Python/diff 정적 검증과 같은 브랜치 push 후, 오케스트레이터가 DB/Docker clean `runtime-agent`를 재실행한다 (`runtime-unverified`).

## 2026-07-13 (Codex worker) · MOMO-355 dogfood agent seed opt-in
- persistent/local-alpha migration은 human+기본 채널만 만들고 agent 0으로 시작하며, 역사적 김인턴/Hermes seed는 demo/e2e 러너만 명시 opt-in한다. `schema_v0.sql`/신규 destructive migration은 없다.
- `scripts/momo`를 gateway-init → pairing invite → credential 발급 → env 순서로 정렬하고, 기존 고정 seed 둘은 exact identity/DB-owner/`--yes` guard가 있는 soft-retire 명령으로만 정리한다.
- runtime-agent/macos-ui verifier는 seed none + 자체 marker/OID fixture 계약을 비접속 Python test로 고정했다. shell/Python/diff, 5패키지 build, Core 18/Server 61/Relay 1/Worker 29/macOS 비스냅샷 78 tests PASS; 기존 image snapshot은 sandbox signal 5로 미실행·PNG 무변경이다.
- 다음: worker PR handoff 후 momo-main이 clean/root runtime-agent+macos-ui와 snapshot 영향 없음 확인 후 merge한다 (`runtime-unverified`).

## 2026-07-13 (Codex worker) · MOMO-356 gateway 운영 공지 timeline 차단
- 어댑터 direct message write를 momo `run_id`가 있는 실제 agent final로 제한하고, Hermes reset/home/`/resume`·`/sethome`/model-provider 공지는 성공 처리+본문 비포함 로컬 로그로만 남겼다. native gateway final은 `/gateway/complete` 유지.
- Hermes 정식 `MOMO_HOME_CHANNEL`을 plugin/enablement/`hermes-gateway-init` 신규·기존 env에 연결해 설정 요구를 기동 전에 해결했다. `schema_v0.sql`·UI·스냅샷 변경 없음.
- adapter contract 54 tests+smoke+pycompile, 실제 SDK result 및 신규·legacy home env init, 수정 shell `bash -n`/실행권한, diff check PASS. verifier DB assertion/runtime-agent gate는 worker 금지로 미실행.
- 다음: 오케스트레이터가 clean/root `runtime-agent`를 수행하고 gate 체크박스/merge를 맡는다.

## 2026-07-13 (Fable) · momo-main · dogfood 첫 실사용 → Phase 0 착수 + 내부알파 방향 확정
- dogfood 실증: gpt-5.5→**gpt-5.6-luna/high** 프로바이더 교체(Hermes config), per-agent bearer 라이브 연결·일반 왕복(@hermes 응답) 실동작 확인. 승인 왕복은 아직 라이브 미검증.
- 실사용 버그 3건 발견·발급: MOMO-354(#341 앱이 roster 대신 demo fixture)·355(#342 에이전트 pre-seed→초대 게이팅 위반)·356(#343 어댑터 운영공지가 durable message 오염). 게이트/verifier가 자체 fixture로 격리돼 안 걸린 종류 — 실사용에서만 드러남.
- **성재 방향 결정(ADR-0103 실질)**: 멀티팀 내부 알파 + **AWS 단일 EC2 실배포** 호스팅. Phase 0(354/355/356 정합)→A(호스팅+클라배포)→B(10인 용량)→C(온보딩 킷).
- 다음: Phase 0 배치 3-worker 스폰(진행 중). 랜딩 후 ADR-0103 정본화 + Phase A 티켓.

## 2026-07-12 (Fable) · momo-main · ADR-0102 배치 전체 종결 (350/341/352 랜딩)
- 랜딩: MOMO-350(#338 `f079279` — status/partial, outbox 경유+상한) → MOMO-341(#339 `6fcb870` — lease/takeover, 게이트가 회귀 2건 검출→resume 반려 2회→시나리오별 단위 테스트 고정) → **MOMO-352(#340 `bb76152` — 동등성 verifier)**. 전 건 clean+root gate PASS.
- **배치 종결**: root runtime-agent full gate에 동등성 검증 상시 포함 — worker/gateway가 run 전이·approval·usage/audit·durable message·realtime publication에서 완전 동일함이 매 게이트마다 증명된다. **legacy secret 호환 창 종료 조건 충족** (ADR-0102 §폐기 일정 2단계).
- 후속(성재 승인 대기): legacy header/`AGENT_GATEWAY_SECRET`/`MOMO_ALLOW_LEGACY_GATEWAY_SECRET` 물리 제거 보안 정리 티켓 (M7 전).
- 다음: ADR-0103 결정 순번. dogfood에서 승인 인박스/스트리밍 실사용 확인 권장.

## 2026-07-12 (Codex worker) · MOMO-352 agent path equivalence verifier
- worker(managed)와 gateway(BYOA) 정본 verifier를 fresh marker/OID DB·per-run 대문자 channel에서 각각 실행하고, trigger→approval→resume→final의 run/approval/usage/audit/message/realtime 보장 manifest를 완전 일치 비교하는 종결 verifier를 추가했다.
- allowlist는 timing/provider metadata/gateway lease/path-channel identity로 코드에 고정했고, source digest EXIT trap과 양 경로 pre-marker exit 96 exact-OID rollback을 자체 강제한다. `schema_v0.sql` 변경 없음.
- `runtime-agent` auto-classify/shell-syntax/add_cmd/coverage에 배선했다. `bash -n`·`git diff --check` PASS; Docker/DB/verifier/local gate는 worker 금지로 미실행(`runtime-unverified`).
- 다음: 오케스트레이터가 clean/root `runtime-agent` 두 경로 PASS와 fresh 보안/correctness 리뷰를 수행하고, legacy secret 물리 제거는 별도 후속 change로 넘긴다.

## 2026-07-12 (Codex worker) · MOMO-341 review fix — lease rejection 4xx audit
- clean `runtime-agent` 2차 게이트에서 takeover 뒤 crashed owner callback이 409 대신 500으로 새는 회귀를 확인했다. 원인은 PostgresNIO가 transaction closure 내부의 `HTTPError(.conflict)`를 `PostgresTransactionError`로 감싸는 데 있었다.
- `/gateway/events`(approval 포함)와 `/gateway/complete`의 lease 부재·불일치·만료·stale owner 거부를 transaction 결과값으로 반환하고 transaction 밖에서 409로 매핑했다. renew/release는 기존부터 UPDATE 결과를 밖에서 409로 매핑했으며, 누락 lease도 409로 통일했다. actor mismatch 403은 유지했다.
- server 단위 테스트에 동시 consumer 단일 claim, crash expiry/takeover, stale owner event/complete/renew/release 거부, expiry reclaim, missing/settled fail-closed를 추가해 61/61 PASS. DB/Docker/verifier는 worker 금지 범위라 오케스트레이터 재검증 대기다.

## 2026-07-12 (Codex worker) · MOMO-341 review fix — approval-held 409
- clean `runtime-agent`에서 승인 대기 late complete가 lease preflight를 먼저 타 500이 된 회귀를 확인했다. migration/claim/renew/release 설계는 변경하지 않았다.
- `awaiting_approval`/`paused`를 lease DTO·DB 검증 전에 `approvalHeld`로 판정해 MOMO-349의 409 human-decision guard를 복원했고, queued/running/terminal의 exact-owner lease 검증은 유지했다.
- server 56 tests PASS. DB/Docker/verifier 재실행은 오케스트레이터 대기(`runtime-unverified`).

## 2026-07-12 (Codex worker) · MOMO-341 gateway durable claim/lease
- 반영: `008_gateway_job_lease.sql` + actor-bound `FOR UPDATE SKIP LOCKED` claim, bounded renew/release, exact job+lease callback 결속, expiry takeover를 outbox SoT에 추가했다. `schema_v0.sql` 변경 없음.
- 어댑터: realtime은 wake-up 전용을 유지하고 serial claim(limit=1)만 provider를 시작한다. 실행 중 lease renew를 감독하며 owner 상실 시 provider task를 취소한다.
- verifier: 같은 agent 두 consumer 동시 claim=capability 1개, active lease 차단, simulated crash expiry/takeover, stale callback·non-owner renew/release 409, owner release/reclaim/complete 시나리오를 격리 DB 패턴에 추가했다.
- 검증: server build+55 tests, adapter 52 tests, py_compile, verifier `bash -n`/실행권한 PASS. DB/Docker/runtime-agent는 미실행(`runtime-unverified`); 오케스트레이터가 merge 전 clean/root gate와 fresh 리뷰를 수행한다.

## 2026-07-12 (Codex worker) · MOMO-350 gateway status/partial
- 반영: actor/run-bound gateway `thinking`/`streaming`을 bounded `agent.status`/`agent.partial` outbox로 투영하고 bearer per-member limit + run당 240 events/minute 하드캡, 2 KiB detail/8 KiB delta 상한을 적용했다.
- 어댑터/클라: provider stream을 512-byte/250ms 단위로 전달하며 macOS REST backend가 exact observable `agent:`를 구독해 기존 `AgentPartialView` state로 합친다. private `agentwork:`와 분리 유지.
- 검증: server 54 tests, adapter 49 tests, macOS 비스냅샷 78 tests(실렌더 타깃 포함), py_compile·verifier `bash -n`/실행권한 PASS. DB/Docker/verifier 미실행(`runtime-unverified`).
- 다음: 오케스트레이터가 격리 DB status/partial 시나리오와 clean/root `runtime-agent`를 수행하고, momo-main이 체크박스·merge를 맡는다.

## 2026-07-12 (Fable) · momo-main · 배치 4 랜딩 — 승인 왕복 실트래픽 도달 (349/351/353)
- 랜딩 3건: MOMO-351(#335, `ebb3a52` — 이중 경로 문서 정본화) → MOMO-353(#336, `8337ae2` — drift-guard, 배치 내 구세대 컨테이너 3곳을 실전 감지·이관하며 자가 실증) → **MOMO-349(#337, `b5b39df` — gateway 승인 왕복, ADR-0102 기함)**. 전 건 clean+root gate PASS.
- 검수 하이라이트: 349 보안 리뷰에서 actor↔run binding이 `requireRunActorBinding` 핸들러 진입점 상속임을 확인(Blocker 0). 353 격리 테스트(합성 dogfood 비접촉) 오케스트레이터 재실행 green.
- momo_main Centrifugo를 fingerprint 컨테이너로 1회 이관(opt-in 재생성) — 이후 config drift는 게이트가 자동 검출한다.
- 다음: MOMO-350(`#330`) 의존 충족·spawn 대기(성재 트리거) → 341 → 352(동등성 verifier, legacy secret 호환 창 종료 게이트).

## 2026-07-12 (Codex worker) · MOMO-349 gateway 승인 왕복
- 반영: actor-bound `approval_request` callback을 기존 approval/message/run/outbox/audit transaction에 연결하고, human approve/reject를 private gateway resume `agent.job`으로 전달한다.
- 어댑터: approval-required tool result를 callback으로 pause하고 approved resume은 재개, rejected resume은 provider 미호출 cancellation ack로 정산한다. terminal late completion도 409 fail-closed다.
- 검증: server build + 51 tests PASS, adapter contract 46 tests PASS, diff 보안 리뷰 Blocker 0. verifier는 격리 DB approval/approve/reject/actor/inbox 시나리오를 추가하고 `bash -n`/실행권한만 확인했다.
- 다음: 오케스트레이터가 merge 전 clean `runtime-agent`와 fresh 보안 리뷰를 수행하고, momo-main이 merge/root gate·잔여 체크박스 갱신을 맡는다.

## 2026-07-12 (Codex worker) · MOMO-353 local gate drift-guard
- 반영: Centrifugo 컨테이너 생성 시 repo config fingerprint를 고정하고 pre/post-start guard가 running fingerprint drift를 fail-closed하며 명시 opt-in에서만 해당 서비스를 재생성한다.
- 안전 경계: gate run marker(uid/repo/run/pid-start)+상속 env+repo command가 모두 맞는 프로세스만 stale/EXIT cleanup한다. unmarked dogfood MomoServer와 사용자 프로세스는 충돌로 남긴다.
- 검증: shell syntax/shellcheck/diff/make dry-run + fake Docker/합성 process-table 오탐 방지 테스트 PASS. 실제 Docker/DB/verifier 및 clean/root gate는 미실행(`runtime-unverified`), 오케스트레이터가 merge 전 수행.
- 다음: worker PR handoff 후 momo-main이 running-config match/drift/opt-in과 실패-run reaping, dogfood 28180 생존을 실제 gate에서 확인한다.

## 2026-07-12 (Codex worker) · MOMO-351 이중 실행 경로 문서 정렬
- 반영: adapter contract·L4 §6·README·architecture를 gateway=BYOA / worker=managed + 서버 소유 보장 매트릭스로 정렬하고 ADR-0102에 SD-5 표면을 소급 승인했다.
- 신원: 두 경로의 `agent_bearer` 수렴과 legacy secret의 equivalence-gate 후 제거·M7 전 시한을 ADR-0101/0102에 연결했다.
- 경계: 코드·shell·DB·Docker 변경/접속 없음. 349/350/341/352 미완 셀은 규범 계약으로 표시하고 완료 evidence로 쓰지 않았다.
- 검증: 링크/앵커 + dirty 허용 `docs` profile PASS; 오케스트레이터가 merge 전 clean docs gate와 체크박스 갱신을 맡는다.

## 2026-07-12 (Fable) · momo-main · ADR-0102 Accepted + 파생 배치 발급
- 결정: 성재가 ADR-0102 **Option C 수락** (gateway=BYOA / worker=managed 이중 경로 + 서버 보장 매트릭스). drift-guard 발급 승인, design-review Medium 2 보류, MOMO-341은 0102 배치 합류.
- 발급: MOMO-349 `#329`(gateway 승인 왕복) → 350 `#330`(status/partial) → 341 `#333`(claim/lease) → 352 `#332`(동등성 verifier), 병렬 351 `#331`(docs)·353 `#334`(drift-guard). 패킷 `handoffs/2026-07-12-adr-0102-execution-path.md`.
- 핵심: 349가 landing되면 **승인 인박스가 실트래픽에서 처음 동작** — agent-native 시그니처 경험 실물화.
- 다음: 성재 트리거로 349부터 codex-fleet spawn. 다음 결정 순번 ADR-0103.

## 2026-07-12 (Fable) · momo-main · MOMO-348 랜딩 — verifier 격리 캐스케이드 전 프로파일 종결 (배치 3)
- 랜딩: goal-325 worker PR #328 검수 — 배치 2 교훈(per-run 채널 UUID + CENT_CHANNEL 대문자)이 프롬프트 반영으로 첫 커밋부터 준수됨. worktree bootstrap+단독+clean full gate PASS 후 merge (`444ee59`), #325 close.
- **종결: root main `macos-ui` full gate PASS** (digest 보존) — runtime-agent에 이어 전 프로파일 green. MOMO-342→348 캐스케이드 완전 닫힘.
- 운영 노트: 1차 worker가 API 무응답 행(CPU 0, 2.5h) → stall 감지 watcher 도입 후 재스폰 10분 완주. 실패 게이트 런의 잔류 MomoServer 포트 점유 재발(오늘 3회) → drift-guard 티켓 제안에 잔류 프로세스 자동 정리 병합.
- 다음: ready 구현 goal 없음. ADR-0102 결정(성재), drift-guard 티켓 승인(성재), design-review 잔여 Medium 2 발급 여부(성재), MOMO-341.

## 2026-07-12 (Codex worker) · MOMO-348 macos-ui real-backend verifier 격리
- 반영: macOS verifier를 unique marker/OID-owned migrated DB와 marker-bound app/worker/relay role로 분리하고 per-run #agent-lab UUID, demo/Hermes·approval/cost fixture를 자체 seed한다.
- 경계: source dogfood DB는 광범위 digest 전후 비교만 하며 exact OID+marker cleanup, marker-bound role cleanup, pre-marker COMMENT 실패(exit 96) rollback 회귀를 `macos-ui`에 배선했다.
- 검증: DB/Docker/verifier 실행 없이 수정·신규 shell `bash -n` PASS; acceptance/gate 체크박스는 미체크 유지한다.
- 다음: 오케스트레이터가 merge 전 fresh REST assertion·성공/실패 digest·clean `macos-ui`를 수행하고, momo-main이 merge/root gate를 맡는다.

## 2026-07-12 (Fable) · momo-main · MOMO-347 랜딩 — codex-fleet 배치 2 완료
- 랜딩: goal-324 worker PR #327 검수 — main 위 rebase(JOURNAL 충돌 해소), 스냅샷 3종 정본 머신 재기록(UI 변경분 2 + 신규 290pt), fresh-context design-review 재판정 **PASS(Blocker 0/High 0)** — 이전 High 2·Medium 4 전부 해소 확인. worktree macos-ui gate full PASS 후 merge (`51db851`), #324 close.
- 잔여: 재판정의 신규 Medium 2(전역 error 행 귀속 오독, 상태 칩 세로 스캔)·Nitpick 3은 티켓 미발급, BUILD_TICKETS에 기록 — 성재가 필요 판단 시 발급.
- 배치 2 결산: 346+347 랜딩, runtime-agent root full gate green, resume 피드백 루프·순서 의존 결함 검시 실증.
- 다음: **MOMO-348(`#325`)이 유일한 ready goal** — landing 시 root 전 프로파일 green. ADR-0102 성재 결정 대기.

## 2026-07-11 (Codex) · worker #324 · MOMO-347 pairing popover hardening
- 반영: 340pt popover를 max-height ScrollView로 제한하고 credential을 flat section으로 임베딩했다. 290pt에서 긴 label/status/menu가 수직 fallback하며 폐기 notice는 해당 행에 붙는다.
- refresh: 일반 중복 조회는 coalesce하고 발급/폐기 뒤에는 기존 in-flight 응답 이후 최신 목록을 재조회한다. mutation 성공 후 목록 조회 실패 시 one-time reveal/폐기 결과는 로컬 메타데이터에 보존한다.
- 검증: macOS build PASS, snapshot suite 제외 77 tests PASS, 신규 290pt snapshot PASS, targeted credential 3 tests PASS. 기존 PNG는 재기록하지 않았고 nominal large-type reference는 동일 바이트로 constrained-window 이름만 정직화했다.
- 리뷰: fresh-context design-review PASS(Blocker 0/High 0, diff-scoped 새 pre-flight 위반 0). 남은 것은 오케스트레이터 정본 snapshot 재기록/clean `macos-ui` gate 후 PR 검수·merge.

## 2026-07-12 (Fable) · momo-main · MOMO-346 랜딩 — verifier 격리 캐스케이드 종결 (codex-fleet 배치 2)
- 랜딩: goal-322 worker PR #326 검수 중 full gate 순서 의존 결함을 격리 DB 실시간 검시로 2단 규명 — ① relay version=seq stale skip(공유 Centrifugo, 성공 응답이며 조용히 drop) → worker resume 반려로 per-run 채널 UUID(`1706590`) ② 채널명 대소문자 불일치(Swift 대문자 vs python 소문자) → CENT_CHANNEL 정규화 직접 수정(`0bb685e`). merge `beceaa1`, #322 close.
- 종결: **root main runtime-agent full gate PASS** — context/live/bridge/gateway 4-verifier digest 보존. MOMO-342→346 캐스케이드 닫힘. 잔여: MOMO-348(macos-ui 프로파일).
- 관찰: 실패 게이트 런의 MomoServer 잔류 누수(MOMO-319 유형) 2건 수동 정리. 파이프라인 실증: codex exec resume 리뷰 피드백 루프 첫 사용.
- 다음: MOMO-347 랜딩(rebase+design-review 재판정+macos-ui gate), 이후 MOMO-348 착수 가능. ADR-0102 성재 대기.

## 2026-07-11 (Codex worker) · MOMO-346 Hermes bridge/gateway verifier 격리
- 반영: external-provider/bridge와 gateway verifier를 각각 unique marker/OID-owned migrated DB로 분리하고 marker-bound runtime role 및 Hermes/#agent-lab fixture를 자체 seed한다.
- 경계: source dogfood DB는 digest 전후 비교만 하며 exact OID+marker cleanup, marker-bound role cleanup, 두 verifier의 pre-marker COMMENT 실패(exit 96) rollback 회귀를 `runtime-agent`에 배선했다.
- 검증: DB/Docker/verifier 실행 없이 수정·신규 shell `bash -n`만 PASS; acceptance/gate 체크박스는 미체크 유지했다.
- 다음: 오케스트레이터가 merge 전 fresh invite/roundtrip/bearer assertions·성공/실패 digest·clean runtime-agent를 수행하고, momo-main이 merge/root gate를 맡는다.

## 2026-07-11 (Fable) · momo-main · MOMO-339 랜딩 — ADR-0101 Phase 1 종결 (codex-fleet 배치 1 완료)
- 랜딩: goal-309 worker PR #323을 검수 — 스냅샷 참조 6종 정본 머신 재기록(worker 샌드박스 렌더링 불일치), main 위 rebase, fresh-context design-review **PASS Blocker 0**, worktree macos-ui gate full PASS 후 merge (`881518b`). ADR-0101 Phase 1 배치(337/338/339) 종결, 패킷 Status `done`.
- 발급 2건: MOMO-347 `#324`(design review High 2·Medium 4 후속), MOMO-348 `#325`(root macos-ui gate가 `verify_macos_real_backend_ui.sh` dogfood 결합으로 중단 — hermes 멤버십 drift로 mention→agent_job 0건, 346 후속).
- 파이프라인 교훈: named 팀메이트(tmux) spawn은 mailbox 미전달 좀비化 — 리뷰 서브에이전트는 이름 없는 일반 spawn (codex-fleet 스킬 반영).
- 다음: MOMO-346‖347 병렬 착수 가능(성재 트리거), 348은 346 후. root full gate green = 346+348. ADR-0102 성재 결정 대기.

## 2026-07-11 (Codex) · worker #309 · MOMO-339 macOS credential pairing UI
- 반영: 초대 후 per-agent bearer 발급, transient one-time reveal, env 복사/권한 안내, 프로필·페어링 목록의 상태/회전/grace/확인 후 폐기/401 복구를 연결했다.
- 보안: raw bearer는 매니페스트·UserDefaults·로그·오류·실제 snapshot fixture에 저장하지 않고 REST create 응답→sheet state에서만 유지한다.
- 검증: macOS build PASS, credential+snapshot 포함 82 tests PASS(기존 MessageBubble snapshot 2개 signal 5 제외), light/dark/고대비/큰 글자 스냅샷 6종 PASS, design-review Blocker 0.
- 남은 것: 오케스트레이터가 merge 전 `macos-ui` 런타임 게이트와 실제 pairing/profile integration·폐기 dialog smoke를 수행한다.

## 2026-07-11 (Fable) · momo-main · MOMO-345 랜딩 + MOMO-346 발급 (codex-fleet 배치 1)
- 랜딩: codex-fleet worker(goal-320)가 만든 PR #321을 리뷰(MOMO-344 패턴 정합 확인)·worktree clean gate full PASS 후 merge (`5854c2f`), #320 close.
- 실증: root post-merge에서 live verifier가 drift 있는 dogfood DB 위에서 PASS + digest 보존. full gate는 hermes bridge/gateway verifier의 dogfood 결합(Hermes `…103` 멤버십 drift + roundtrip이 dogfood 채널에 메시지 작성)에서 중단 → MOMO-346 `#322` 발급 (캐스케이드 종결 티켓, `status:ready`).
- 병행: goal-309(MOMO-339 pairing credential UI) worker 실행 중. 파이프라인 개선: worktree 커밋은 `--add-dir <메인repo>/.git` 필요.
- 다음: MOMO-346 착수(성재 트리거), goal-309 완주 시 검수 사이클, ADR-0102 성재 결정 대기.

## 2026-07-11 (Codex worker) · MOMO-345 live channel verifier 격리
- 반영: live verifier를 unique marker/OID-owned migrated DB와 marker-bound app(NOBYPASSRLS)·worker/relay(BYPASSRLS) role로 분리하고 authorized/negative fixture를 자체 seed한다.
- 경계: source dogfood DB는 agent queue/run/approval/message digest 전후 비교만 하며, exact OID+marker cleanup과 pre-marker COMMENT 실패 rollback helper를 추가했다.
- 검증: DB/Docker/verifier 실행 없이 `bash -n`만 PASS; fresh bootstrap·live assertions·clean/root `runtime-agent` evidence는 오케스트레이터 merge 전 대기.
- 다음: PR 리뷰/런타임 gate 후 momo-main이 merge·root post-merge gate·체크박스 갱신.

## 2026-07-11 (Fable) · momo-main · MOMO-344 검수 마무리 + MOMO-345 발급
- 마무리: GPT sol이 중단한 MOMO-344를 인계받아 재리뷰(P1 4건 반영 확인 + 실행권한 결함 1건 수정), 타깃 검증·clean gate PASS 후 PR #319 merge (`0b2c94a`), #318 close.
- 발견 1: root post-merge gate에서 `verify_agent_live_channel.sh`가 dogfood DB demo 시드 drift(agent 멤버십 left_at)로 실패 → 스코프 확장 대신 MOMO-345 `#320` 발급 (`status:ready`).
- 발견 2: momo_main Centrifugo가 MOMO-338 이전 running-config로 기동 상태(107/102 오류) → 재시작으로 해소. drift guard 티켓은 성재 승인 대기 제안.
- 다음: MOMO-339 `#309`(macOS pairing credential UI)와 MOMO-345 `#320` 병렬 착수 가능. ADR-0102 결정은 계속 성재 대기.

## 2026-07-11 (Codex) · momo-main · MOMO-344 context verifier 격리
- 발견: PR #317 post-merge root gate에서 `verify_agent_context.sh`가 persistent dogfood DB의 unrelated `resume_approval` job을 claim해 context trigger가 starvation 됐다.
- 결정: production Worker claim 정책은 바꾸지 않고 verifier에 unique migrated DB, marker-bound NOBYPASS app/BYPASS worker role, exact OID+marker cleanup을 적용한다.
- 검증 계획: source queue/run/approval/message digest 보존 + 기존 context assertions + full runtime-agent + 리뷰 + root post-merge gate.

## 2026-07-11 (Codex) · momo-main · MOMO-343 fresh bootstrap 회귀
- 발견: MOMO-342 merge 후 root main 새 포트에서 psql `-c` marker 변수가 치환되지 않아 fresh verifier DB bootstrap이 syntax error로 중단되고 unmarked DB가 남았다.
- 반영: COMMENT를 psql stdin SQL로 이동하고, cleanup 직전 exact generation marker를 재검증하며 동일 marker의 전용 role만 NOLOGIN/제거한다. role bootstrap은 트랜잭션화했고 unique DB의 실패 rollback, fresh 성공, persistent 재실행을 한 회귀 helper로 고정했다.
- 추가 발견: cold worktree dependency materialization이 MomoServer health timeout에 포함됐다. 세 runtime binary를 timeout 전에 동기 build하도록 분리했다.
- 검증: fresh DB bootstrap + persistent 재실행 + root main runtime-agent post-merge gate 예정.
- 다음: #316 merge/root gate 후 MOMO-339 pairing credential UI로 복귀.

## 2026-07-11 (Codex) · momo-main · MOMO-342 main gate 복구
- 발견: MOMO-338 merge 후 persistent main DB에서 user-owned Hermes membership이 제거돼 AgentWorker verifier가 migration seed를 잘못 전제했다.
- 반영: source DB와 물리적으로 분리된 marker-owned migration DB, generation별 fixture UUID, verifier-only workspace/human/channel/agent/budget, 고정 ID/alias 소유권 guard, exact client-message 기반 cleanup, empty run fail-fast 진단을 추가했다.
- 리뷰 반영: body/agent-wide 삭제를 제거하고 unrelated message/pending job/membership/Hermes 보존 sentinel, marker-bound 전용 app/relay/worker role, 전역 consumer의 isolated DB 연결, source/system/unmarked DB 거부, runtime-agent 2회 실행을 추가했다. 서버는 사전 build executable을 직접 띄워 SwiftPM planning lock도 피한다.
- 검증: 동일 persistent verifier DB에서 AgentWorker verifier 연속 2회 PASS, source DB untouched 확인; 전체 runtime-agent gate와 main 재검증 예정.
- 다음: #314 리뷰/merge/root main gate 후 MOMO-339 pairing credential UI 착수.

## 2026-07-11 (Codex) · momo-main · MOMO-338 보안 재리뷰
- 발견: realtime payload 직접 실행, run/channel 위조, credential-coarse realtime revocation, token-shaped error/argv 노출을 P1/P2로 확인.
- 반영: realtime wake-only + pending REST 재조회, exact `meta.token_id` liveness, agent run binding, 양단 redaction과 stdin verifier를 적용.
- 검증: adapter 40 tests, server 49 tests, terminal 401/4xx·full-page·reconnect/shutdown race, revoked JWT/cross-channel run/private agentwork 및 gateway verifier PASS.
- 다음: clean gates와 재리뷰 후 PR merge/root main fast-forward. 다중 instance lease는 MOMO-341.

## 2026-07-10 (Codex) · momo-main · MOMO-338 리뷰 보강
- 발견: `agent:` 하나에 observer progress와 private Context Packet job이 섞여 보안 self-only 수정이 기존 live UX를 깨뜨렸다.
- 반영: `agent:` progress / `agentwork:` private job 분리, cancellation/reconnect/recovery/backpressure 및 verifier secret lifecycle 하드닝.
- 검증: adapter 33 tests(실시간/recovery 단일 provider worker), server 48 tests, exact-channel agent live + private agentwork WebSocket/relay + Hermes gateway runtime verifier PASS.
- 다음: clean docs/runtime-agent gate와 PR merge 후 root main fast-forward. 다중 instance lease는 MOMO-341.

## 2026-07-10 (Codex) · momo-main · MOMO-338 통합 준비
- 한 일: Hermes adapter를 per-agent bearer 하나로 단일화하고 login/shared-secret을 제거. realtime-first reconnect + bounded recovery/cache + legacy env migration을 추가.
- 리뷰 반영: 다른 agent의 Context Packet을 볼 수 있던 subscribe proxy를 self-only로 강화하고 actor/env 교차검증, non-loopback TLS 기본값, smoke session revoke를 적용.
- 이탈: Python adapter 범위에서 server transport auth까지 확대(보안 blocker, DEVIATION_LOG accepted). 중복 gateway lease는 후속 티켓.
- 다음: runtime-agent clean gate·PR merge 후 root main fast-forward. 그다음 MOMO-339 및 gateway lease 티켓.

## 2026-07-10 (Codex) · momo-main · MOMO-337 통합
- 한 일: PR #310 보안/성능 리뷰에서 one-time token no-store, 발급자 provenance, pending `available_at`을 수정하고 main `8d97c82`로 merge. post-merge `runtime-agent` PASS.
- 이탈: 예상만 있던 `/gateway/jobs/pending`을 actor-bound recovery endpoint로 신설. #308에는 realtime-first + bounded recovery 계약을 추가.
- 현재: #307 done, #308(M1)/#309(M3) ready·병렬 가능. ADR-0102는 여전히 성재 결정 대기.
- 다음: runtime 임계경로인 MOMO-338을 먼저 claim하고, 별도 worker에서 MOMO-339를 병렬 진행 가능.

## 2026-07-10 (Codex) · GPT 5.6 · 기획 체계 보강
- 한 일: Fable 인수 내용을 검토하고 `CURRENT_STATE.md` 중심의 압축 복원, planner 병렬 claim, `momo-main` 순차 통합, versioned handoff 규칙을 정본에 추가.
- 열린 것: ADR-0102는 성재 결정 대기. GitHub 실측상 MOMO-337(#307)은 이미 별도 worktree에서 in-progress(PR 없음). root main의 기존 Hermes/local-dogfood 변경은 분리 유지.
- 다음: #307 PR handoff를 기다리며 ADR-0102 결정. 병렬 planner는 `CURRENT_STATE.md`에서 서로 다른 planning ID를 먼저 claim.

## 2026-07-10 (오후) · Fable · 기획+오케스트레이션
- 한 일: 협업 파이프라인 정본화(docs/planning/* 신설, CLAUDE.md, momo-planning 스킬, PR 이탈 섹션). 이슈 #307(ready)/#308/#309(blocked) 발급 + 핸드오프 패킷. ADR-0102 기안(Proposed).
- 열린 것: **ADR-0102 성재 결정 대기(권고 C)** · #307 착수는 성재가 Codex에 직접 요청 예정 · 기획/문서 배치는 main에 커밋됨(성재 승인, 이전 세션의 코드 핫픽스 변경은 여전히 미커밋 — 그 배치의 주인이 처리).
- 다음: 성재의 0102 결정 → 파생 티켓. #307 PR 오면 momo-main 리뷰 사이클 가동.

## 2026-07-10 (오전) · Fable · 기획
- 한 일: ADR-0100(거버넌스)·0101(에이전트 신원, Option A) 성재 승인 → Accepted. ux-bible/architecture 정본 신설. MOMO-337~339 수용기준 발급(BUILD_TICKETS).
- 열린 것: 없음 (전부 오후 세션으로 인계됨).

## 2026-07-09 · Fable · 진단
- 한 일: 6방향 코드베이스 감사 + Slack UX 딥리서치(36소스) → 진단 아티팩트(https://claude.ai/code/artifact/1e7d94cf-094c-4b66-b2b9-dbef028bee06). 판정: 골격 견고 / 신원·체감 레이어가 봇 수준 / 전면 리라이트 비추천. ADR 결정 큐 0100~0109 수립.
- 열린 것: 결정 큐 0102~0109 (0100·0101은 다음 날 처리됨).
