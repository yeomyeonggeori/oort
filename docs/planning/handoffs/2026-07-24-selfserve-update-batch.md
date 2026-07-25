# 핸드오프 패킷 — 셀프서브+업데이트 배치 (MOMO-589~593 / #731~735)

> 근거: `2026-07-24-selfserve-operator-journey-plan.md`(성재 승인) + ADR-0117 증보2(Accepted) + 온보딩 감사. 이슈 본문이 티켓별 수용기준 정본.

## 재사용 포인터
- **589 REST**: 인가=`ProviderLinkRoutes.isProviderLinkOperatorAuthorized` 모델(583) 재사용. 시딩 로직 원본=`infra/prod/create_workspace.sql`(#general·channel_seq·owner 멤버십·D5-A 계정 복제·slug 중복 거부). tx/RLS 관례=OnboardingGreeting.swift(단일 tx, GUC). verifier 형식=verify_provider_link.sh, 포트 28290대. 마이그레이션 필요 시 **041**.
- **590 GUI**: 설정 셸/권한안내/상태 패턴=MomoProviderLinkSettingsView(574). 세션 전환=MomoServerSessionController.switchSession. 운영자 노출 게이팅=ChannelListView aiConnection/workHost 항목 패턴.
- **591 초대 메일**: 기존 초대 GUI=MomoServerSession.swift `createInvite`(:302)+inviteCreated 카피(:2905~). 딥링크 계약=`docs/onboarding-deeplink.md`(momo://join?server&code, server=percent-encoded 현 세션 base URL). mailto는 RFC 6068 인코딩(subject/body percent-encode), NSWorkspace.shared.open.
- **592 런북**: 실코드 대조 대상=workers/WorkHostDaemon(momo-workd), WH-2 페어링(MomoWorkHostEngineSettingsView), 주소 온보딩(MomoAgentOnboarding, canManageWorkspace 게이팅), verify_acp_host.sh·mock_acp_agent.py. 내부알파 대상=momowebqa(127.0.0.1:28000, scripts/internal_alpha_stack.sh).
- **593 pill**: manifest 소비=MomoMacUpdateChannelStatus(MomoAccountSettingsViews.swift:1132~ Updates 표면), 사이드바 하단=ChannelListView(Settings 행 부근), Updates 진입=기존 profile 메뉴 route 재사용.

## 함정
- UUID 문자열 비교는 항상 케이스 무관(577·582·588 3연속 전례). PostgresNIO: bytea=ByteBuffer, nil 파라미터 `::text`. 두 env 템플릿 동시 갱신. 스냅샷 기준이미지 기록 금지(gated). em-dash 0·과장어 0. Linux: @preconcurrency import Crypto·명시 의존.
- 590·591·593이 모두 track/uxui 클라 파일을 만질 수 있음(ChannelListView 등) — 서로의 영역 밖 리팩터 금지, 최소 침습으로(머지 순서는 오케스트레이터가 rebase로 조정).

## 공통 하드 룰
지정 worktree에서만. PR/merge/close/gate 금지 — 커밋 후 STOP. schema_v0 불변. 시크릿 금지. build+단위테스트 커밋 전 통과. 보고는 스키마 그대로 실값만.
