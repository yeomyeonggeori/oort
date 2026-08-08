# 파일 저장 + RAG — Google Workspace(Drive) 기반 아키텍처 (2026-07)

> 01 문서 Track B의 "파일 업로드가 숨은 최대 리스크(스토리지 백엔드 결정)"를 해소하는 설계.
> **기존 정본과의 관계:** MOMO-122(`research/11-agent-runtime/12-google-workspace-connector-v0.md`, per-user OAuth·read-mostly·approval-gated writes)와 MOMO-123(enterprise admin/DWD overlay)을 **확장하며 모순되지 않는다.** 단 §5의 정정 1건 포함.
> 결론 먼저: **자체 오브젝트 스토리지를 만들지 않는다.** workspace당 공유 드라이브 1개 + 서비스 계정 멤버십으로 Drive를 스토리지 계층으로 쓰고, RAG는 pgvector 파생 인덱스 + 김인턴 위키 2층으로 간다.
> **2026-07-14 상태:** 아래 workspace archive/shared-drive 경로는 보안·retention ADR 전 역사적 제안으로 동결됐다. `MOMO-320` 번호는 완료된 env drift guard 전용이므로 재사용 금지다. 첫 권고 slice는 새 ID의 per-user selected-file read/citation이며 최신 계약은 `docs/planning/proposals/2026-07-14-superapp-engine-roadmap.md`를 따른다.

---

## 1. 왜 Drive인가 (리소스 효율 비교, ≤10인 self-hosted 기준)

| | **Drive(공유 드라이브)** | 자체 S3호환 | 로컬 볼륨 |
|---|---|---|---|
| 비용 | **한계비용 $0** (팀이 이미 내는 Workspace 풀 스토리지) | 서버+디스크+운영 | 디스크만 |
| 운영 부담 | **최저** — 내구성·버저닝·프리뷰어·모바일·공유 전부 공짜 | 최고. **MinIO OSS 사실상 사망**(2025-05 Console 제거, 2026-04 repo 아카이브) → Garage/SeaweedFS로 갈아타야 함 | 백업/DR 전부 자체 |
| 백업 | Google 책임 | 자체 복제+오프사이트 | 전부 자체 |
| RAG 파이프라인 | changes.list가 변경 피드를 공짜로 제공 | 버킷 알림, 바이트는 로컬(최속) | inotify |
| 탈출 비용 | file id + 폴더 트리, export 가능 | 없음 | 없음 |

ADR-0002(compose 레이어링)에 스토리지 서비스를 추가하지 않아도 된다는 점이 결정적 — **infra 표면적이 늘지 않는다.** 단, 비-Google 배포를 위해 `AttachmentStore` 프로토콜 추상화는 유지(백엔드: drive | local-volume, v0는 drive만 구현).

## 2. 인증 아키텍처 — 핵심 발견: internal-app 면제

**검증된 정책 사실(2025-2026):**
- `drive.file` = non-sensitive(검증 간소). `drive`, `drive.readonly`, **그리고 `drive.metadata.readonly`도 restricted**-class.
- Restricted scope는 연 1회 CASA 평가 요구(Tier 2 ≈ $540-1,800, Tier 3 ≈ $4,500 — 3rd-party 추정치). self-hosted OSS엔 비현실적.
- **그러나 OAuth 클라이언트의 consent screen이 Internal(같은 Workspace 조직 소유 GCP 프로젝트)이면 Google 검증·CASA 자체가 면제.** self-hosted oort는 배포 조직마다 자기 GCP 프로젝트를 만들므로 정확히 이 케이스다. → scope 상한을 정하는 것은 Google 검증 경제학이 아니라 **oort 자체 정책(비보관·최소권한)**이 된다.

**3-모드 구조 (MOMO-122/123에 1개 모드 추가):**

| 모드 | 무엇 | 검증 부담 |
|---|---|---|
| A. per-user OAuth `drive.file` + Picker | 사용자 개인 Drive 파일을 소스로 선택 (기존 v0 기본, 불변) | 없음 |
| B. **workspace archive (신규)**: workspace당 공유 드라이브 1개 + 서비스 계정을 **그 드라이브에만** Content Manager 멤버로 추가 | 메신저 업로드의 저장소 + 인덱싱 크레덴셜. **DWD 아님** — SA는 자기 자신으로서 공유 드라이브 1개만 접근, 도메인 전권/사칭 없음. MOMO-123의 `service_account_boundary`에 `boundary_kind=shared_drive_member` 추가로 수용 | 없음 (user consent flow 자체가 없음) |
| C. DWD overlay | 기존 MOMO-123 그대로, ≤10인 팀엔 과잉 | Admin console 수동 |

SA 키는 MOMO-123 boundary 그대로 `credential_storage_ref`(암호화 저장, 키 바이트 비저장). Google이 직접 권고하는 패턴이기도 하다: "SA가 콘텐츠를 소유하게 하지 말고(SA My Drive 15GB 캡) 공유 드라이브에 넣어라."

## 3. 파일 저장 설계

- **레이아웃:** 공유 드라이브 `momo — {workspace}` / `channels/{channel_slug}/YYYY/MM/`. 공유 드라이브 파일은 **조직 소유** → 퇴사자 소유권 이전 문제 원천 차단.
- **한도(공식, ≤10인엔 전부 여유):** 드라이브당 500k 아이템, 멤버 600, 파일 최대 5TB, 업로드 **사용자당 750GB/일**. API 쿼터: 프로젝트당 1M units/min. ⚠️ Google이 무료 임계 초과분 **2026년 과금 전환 예고**(90일 노티) — 워처 필요.
- **업로드 경로:** 서버가 resumable upload 세션을 발급하고 **Swift 클라가 직접 청크 PUT** → 파일 바이트가 Hummingbird 서버를 경유하지 않음(메모리/대역폭 절약). 업로더가 Google grant 보유 시 본인 `drive.file` grant로(귀속+쿼터가 사용자 단위), 없으면 SA로.
- **메시지 바인딩:** 기존 `file` 테이블 확장 — `drive_file_id`, `head_revision_id`, `web_view_link` 저장. `thumbnailLink`는 **수 시간 단명+credentialed** → 절대 저장하지 말고 서버 프록시로 on-demand 재파생 (MOMO-122의 "메타데이터만 저장" 규칙과 일치).
- **권한:** 채널 ACL을 Drive per-file 권한으로 미러링하지 않는다(그건 approval-gated `share_file`/`change_permission` 경로). Drive 접근은 팀 단위로 굵게, 채널 가시성은 oort(Context Packet/RLS)가 집행 — 기존 스펙 그대로. **비공개 채널 첨부는 v0에서 공유 드라이브 제외**(업로더 개인 Drive에 `drive.file`로, oort는 file id만 보관).

## 4. RAG — 2층 구조 (위키 + 파생 인덱스)

### 4.1 인덱싱 파이프라인 (권장: 추출→청크→pgvector)

```
Drive changes.list 폴러 (workspace당 1개, SA credential, driveId 필터, 1~5분 주기)
  → 신규/변경: files.export(Docs류) 또는 files.get?alt=media → 추출 → 청크
     · Docs export 10MB 캡 우회 = files.get?fields=exportLinks 경유 다운로드
  → 임베딩 워커(01 문서 Track D의 서버측 임베더) → pgvector halfvec HNSW
     · 행 스키마: source_id, workspace_id, drive_file_id, head_revision_id,
       permission snapshot version — MOMO-122의 source ref 모델 그대로
  → 삭제/권한상실 tombstone → 벡터 삭제 + Memory Plane revalidation 큐
```

- **폴링이 정답**(≤10인): 폴 1회 ≈ ~100 quota units, 무시 가능. `changes.watch` 웹훅은 public HTTPS + 7일 채널 만료 + 자동갱신 없음 → self-hosted(NAT 뒤 가능)에선 **선택적 레이턴시 최적화**로만.
- Drive API `fullText contains` 검색은 **후보 파일 recall 프리필터/폴백**으로만 (토큰 매칭 한계 + **한국어 세그먼테이션 무보증** — 자체 테스트 전 신뢰 금지). Vertex AI Search/Gemini File Search는 corpus 사본이 Google 관리 스토리지로 나가고 검색이 Gemini에 묶여 self-hosted BYOK 경계와 충돌 → 주 인덱스로 부적합(임베딩 자체 운영을 원치 않는 팀용 문서화된 escape hatch로만).

### 4.2 "LLM 위키" 층 (사용자 제안 채택 — 정답은 both)

Karpathy의 LLM knowledge base 패턴 + DeepWiki/memory-bank 프랙티스 기반:

- **위키 = 1차 응답 층**: 김인턴이 유지하는 큐레이션 문서(공유 드라이브 안의 Google Docs). 팀 규모에선 위키 전체가 컨텍스트 윈도에 들어가 retrieval이 사소해짐. 사람도 Drive에서 직접 편집 가능.
- **위키 편집 = approval-gated `propose` write가 채널 타임라인에 노출** — oort의 "거버넌스 인 컨버세이션" 원칙과 정확히 맞물리는 지점. 에이전트의 지식이 감사 가능한 아티팩트가 된다.
- **원문 RAG = 증거 층**: "계약서 PDF에 정확히 뭐라고 써 있었나"는 위키가 못 답한다. 위키의 모든 주장에 `source_id → webViewLink` 인용을 강제(Memory Plane의 `artifact_ref`/`external_source_ref` 분리 그대로).
- 위키 문서 자체도 같은 pgvector 파이프라인에 인덱싱됨(공유 드라이브 안에 있으므로 자동).

## 5. 기존 스펙 정정·보강 (차기 리비전에 반영)

1. **정정**: MOMO-122의 scope 표가 `drive.metadata.readonly`를 가벼운 metadata scope처럼 다루나 실제로는 **restricted-class**. Internal consent 전제를 명기해야 함.
2. **보강**: "no full Drive mirrors" 규칙에 **"oort 관리 공유 드라이브에 한해 revocable 파생 인덱스(임베딩+청크 텍스트) 허용"**을 명시 — 사용자 개인 Drive(`drive.file` 선택 파일)는 기존대로 excerpt-only.
3. **보강**: MOMO-123 `service_account_boundary`에 `boundary_kind: shared_drive_member` 추가(DWD보다 좁은 제3모드).

## 6. 티켓 제안 + 검증 필요 항목

| 제안 | 내용 | 우선순위 |
|---|---|---|
| GWS-ARCHIVE-ID-PENDING | `AttachmentStore` 프로토콜 + workspace archive 모드(공유 드라이브 프로비저닝 + SA 멤버십) + resumable 업로드 클라 직송. ADR-0113/0116 전 동결 | P1 후보. MOMO-320 재사용 금지 |
| MOMO-321 | changes.list 폴러 + 추출/청크/임베딩 워커 + tombstone→Memory Plane 연결 | P1 (MOMO-310과 병합 가능) |
| MOMO-322 | 김인턴 위키 v0: 위키 문서 규약 + propose-write 승인 플로우 + 인용 강제 | P2 |
| MOMO-323 | 스펙 정정 3건(§5) + Internal consent 셋업 runbook(`docs/`) | P1 (문서만, 빠름) |

**착수 전 실증 2건 (runtime-unverified 항목):**
1. `drive.file` scope의 SA + 공유 드라이브 멤버십 조합으로 changes.list/다운로드가 충분한지 (불충분하면 SA만 `drive.readonly` — Internal이라 검증 면제지만 MOMO-123 scope inventory에 기록).
2. Drive API `fullText contains` 한국어 실측 (테스트 공유 드라이브로).
