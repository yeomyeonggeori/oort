# 업계 권한·워크스페이스·조직 모델 조사 (2026-07-21, Fable)

> 발단: 성재 — Slack rearchitecture 발표(InfoQ) 포함, Slack/Discord/셀프호스트 메신저의 권한·워크스페이스·org 핸들링(인프라 포함) 조사.
> 방법 주기: deep-research 서브에이전트가 무응답 좀비화(teammate-mailbox 전례 재발 — named spawn 금지 교훈 재확인)되어, InfoQ는 직접 fetch, 나머지는 공지식 기반으로 Fable이 직접 작성. 개별 수치·명칭은 공식 문서 대조 전 참고용.
> 소비처: docs/planning/2026-07-21-permissions-workspace-diagnosis.md · ADR-0128 · ADR-0117(예약)

## 1. Slack — rearchitecture 발표 핵심 (Ian Hoffman, QCon SF 2024 / InfoQ)

**아키텍처 3세대** (출처: infoq.com/presentations/slack-rearchitecture/ — 직접 fetch 요약):
- **V1 (초기)**: 워크스페이스 = 폐쇄 시스템·독립 고객 단위. 데이터 공유 없음. **워크스페이스 ID 샤딩** — 한 워크스페이스의 모든 데이터가 한 샤드에.
- **V2 (Enterprise Grid, 2017)**: org 아래 다중 워크스페이스. 유저가 org 내 여러 워크스페이스 접근 — 단 "전환" UX(뷰는 워크스페이스 단위).
- **V3 (Unified Grid, 2023-24)**: 유저가 접근 가능한 전 데이터를 **단일 뷰**로. 토큰이 org 스코프로 전환.
- **재샤딩**: 메시지를 Vitess로 **채널 ID 샤딩** 이관("같은 채널의 메시지는 같은 샤드"). 워크스페이스 샤딩을 버린 이유 = 대형 워크스페이스 핫샤드 + 워크스페이스 경계를 넘는 접근(Grid·Connect)이 늘며 경계=샤드 가정이 깨짐.
- **권한 일관성 이슈(발표 명시)**: "admin인 워크스페이스에서만 채널 수정 가능, 다른 워크스페이스에선 불가" 같은 모순 → Unified Grid에서 유저의 **모든 워크스페이스를 교차 확인하는 권한 헬퍼**로 해소. 교훈: 권한 판정을 호출부마다 흩뿌리지 말고 단일 헬퍼로 중앙화해야 모델 진화가 가능.

**역할 체계 (Slack 공지식)**: Primary Owner(1명, 이양만 가능) > Owner > Admin > Full Member > **Guest(multi-channel / single-channel)**. 초대·킥·역할 변경은 Owner/Admin, Owner 조작은 Owner만. 파일 접근은 **채널 멤버십에서 파생**(채널에 있으면 그 채널 파일 접근). 유저는 여러 워크스페이스에 **이메일 계정 단위**로 가입(계정 전역, 워크스페이스별 프로필) — "평균 유저가 ~3개 워크스페이스" 사용 문법의 기반.

## 2. Discord — 역할 비트필드·계층·kick/ban

- **커스텀 역할 모델**: guild(서버)당 임의 개수의 역할, 각 역할 = **권한 비트필드**(BAN_MEMBERS, MANAGE_CHANNELS 등 ~50비트). 유저 권한 = 소속 역할들의 OR + 채널별 **오버라이드**(allow/deny 2중 비트필드, 역할·유저 단위).
- **계층 규칙(핵심)**: 역할 목록의 **위치가 곧 서열** — 자기 최고 역할보다 **아래**의 역할/유저만 관리(kick/ban/역할 부여) 가능. 서버 Owner는 예외적 최상위. → momo 0128 D2의 "자기보다 높거나 같은 역할 조작 불가"의 원형.
- **kick vs ban 분리**: kick = 내보내기(재초대로 즉시 복귀 가능), **ban = 계정+IP 차단 원장**(해제 전 재입장 불가). 초대 링크가 아무리 살아 있어도 ban이 우선 — momo P2의 "초대 redeem 시 banned 검사"와 동일 구조.
- 시사점: 비트필드 커스텀 역할은 강력하나 UX·감사 복잡도가 큼. Slack형 고정 역할 + 채널 단위 역할이 팀 메신저에는 충분(Discord도 커뮤니티 규모라서 필요했던 것).

## 3. 셀프호스트 메신저 — Mattermost · Matrix

- **Mattermost**: **3층 고정 역할** — System Admin(인스턴스 전역) / Team Admin / Channel Admin + Member·Guest. 스킴(scheme)으로 팀·채널별 역할 커스텀 가능(EE). 유저 계정은 인스턴스 전역, 팀에 다중 소속. deactivate(로그인 차단·데이터 보존)와 완전 삭제 분리 — momo 0128 D3의 suspend/deleted 분리와 동일. 관리자 콘솔에 감사 로그.
- **Matrix (Element)**: **power level(0~100 정수)** — 방(room)별로 유저마다 부여, 행위별 요구 레벨(메시지 50, kick 50, ban 50, 방 설정 100 등)을 방 상태로 선언. 유연하지만 "관리자=100, 모더레이터=50, 일반=0" 관례로 수렴 — 결국 고정 역할처럼 쓰임. 연합(federation)이라 ban도 방 상태 이벤트.
- **Zulip**: Owner/Admin/Moderator/Member/Guest 고정 역할 + 스트림(채널) 단위 구독. 조직(realm) 전역 계정.
- 공통: 셀프호스트 3종 모두 **①인스턴스/조직 전역 계정 ②워크스페이스(팀/realm) 역할과 채널 역할 분리 ③deactivate·삭제 분리 ④관리자 감사 표면**을 갖춤 — 셀프호스트 신뢰의 기본기.

## 4. 공통 패턴 (업계 수렴 답)

1. **3계층 스코프**: org(선택) > workspace/team > channel — 각 층에 독립 역할. 채널 역할에서 워크스페이스 역할을 유도하는 제품은 없음(momo P3가 이례).
2. **계층 관리 규칙**: 자기와 같거나 높은 서열은 조작 불가, 최상위(Primary Owner/서버 Owner)는 이양만.
3. **kick과 ban의 분리**: 내보내기(복귀 가능)와 차단(원장 기반 재입장 불가)은 별개 동작 — ban 원장은 초대/가입 경로 전부에서 검사.
4. **suspend(deactivate)와 delete의 분리**: 로그인 차단·데이터 보존 vs 소거 절차. 메시지 이력은 퇴장 후에도 보존(저자 표시 유지).
5. **guest 등급의 상품화**: 채널 제한 게스트(single/multi-channel)가 외부 협업 표준.
6. **파일 접근 = 채널 멤버십 파생**: 별도 파일 ACL 없음 — momo는 이미 이 원칙(첨부 proxy가 membership 검사).
7. **계정은 전역, 워크스페이스는 연결**: 유저 1명 = 계정 1개 = N개 워크스페이스 멤버십. 워크스페이스 스코프 계정(momo 현행)은 업계에 없음.
8. **권한 판정의 중앙화**: Slack 교훈 — 판정 로직을 헬퍼 하나로 모아야 모델 진화(Grid→Unified) 시 호출부 전수 수정을 피함.

## 5. momo 시사점 (RLS 단일 PG 구조에서)

- **Slack의 재샤딩 고통은 momo에 없음**: momo는 단일 PG + RLS라 "워크스페이스 샤딩을 버리는" 물리 이관이 불필요. Slack이 하드웨어로 치른 비용을 momo는 **논리 모델(계정-워크스페이스 분리)만으로** 해결 가능 — ADR-0117이 스키마 작업(human의 email 전역화 + workspace 연결 테이블)이지 인프라 작업이 아니라는 뜻. 단, RLS 정책이 "요청 = 단일 workspace 스코프" 가정을 유지하므로 **Unified Grid식 교차 워크스페이스 단일 뷰는 v2+**(클라이언트 합성으로 시작, 서버 교차 쿼리는 열지 않음).
- **권한 헬퍼 중앙화 선행**: 0128 D1의 requireWorkspaceAdmin 이관이 정확히 Slack 교훈의 실행 — 지금 호출부가 적을 때 중앙화해야 0117 때 재수술이 없다.
- **역할 4종(owner/admin/member/guest) 고정은 유지**: Discord식 비트필드는 과설계. Mattermost EE 스킴 같은 커스텀은 수요 발생 시 v2.
- **에이전트=member 대칭이 차별점**: 업계 어디도 에이전트를 역할 체계 1급으로 안 다룸 — suspend 시 credential revoke(0128 D6)는 momo가 처음 정의하는 패턴.
