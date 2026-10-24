# PostgreSQL 마이너 업그레이드 (SEC-06, #4244)

RLS FORCE가 테넌트 경계라서 DB 마이너는 보안 패치 선(현재 **18.6 이상**, `server_version_num` ≥ 180006)보다 뒤처지지 않게 둔다.
저장소 핀은 `pgvector/pgvector:0.8.7-pg18-trixie@sha256:9d9c9302…`(PG 18.6)다. **이미 돌고 있는 운영 DB는 이 핀을 바꿔도 저절로 올라가지 않는다.** 아래 절차로 따로 올린다.

## 저장소 안 핀을 올릴 때
1. 새 태그의 멀티 플랫폼 인덱스 digest와 PG 버전을 읽는다(컨테이너 없이, 네트워크만).
   `docker buildx imagetools inspect pgvector/pgvector:<태그> --format '{{json .Image}}'` 의 `PG_VERSION`이 두 플랫폼 모두 하한 이상이어야 한다.
2. 옛 digest·태그를 `git grep`으로 찾아 한꺼번에 바꾼다(compose, pgBackRest Dockerfile, `infra/railway/railway.json`, `scripts/verify_*.sh`, `scripts/tests/test_publish_images_contract.py`). 역사 기록(`docs/planning`, `docs/adr`, `claudedocs`)은 고치지 않는다.
3. `legal/THIRD_PARTY_NOTICES.md`의 pgvector 버전과 그 해시(`GHCR_NOTICE_BUNDLE.sha256`·`GHCR_NOTICE_MANIFEST.json`), 이미지에서 뽑는 `DEBIAN_COPYRIGHT_INVENTORY.oort-postgres.txt`를 맞춘다.
4. 시험: `python3 scripts/tests/test_postgres_version_floor.py --registry`(핀 일관성 + 레지스트리 PG_VERSION 하한), 격리 컨테이너로 `python3 scripts/tests/test_postgres_version_floor.py --runtime`(`SHOW server_version_num`), `python3 scripts/tests/test_publish_images_contract.py`.
   하한 숫자는 `FLOOR_NUM`(시험 파일 상단) 하나다. 올릴 때 이 값도 올린다.

## 운영 DB를 올릴 때 (별도 배포, owner 사전 공지 필수)
같은 메이저(18) 안의 마이너 교체라 데이터 디렉터리는 그대로 쓰지만 **DB 재시작(짧은 끊김)** 이 따른다. 한가한 시간에 한다.
1. 사전 공지를 남긴다(예상 끊김 시간·시각).
2. 백업을 먼저 확인한다: 최신 pgBackRest 백업·아카이브가 정상인지 [pgbackrest-pitr](pgbackrest-pitr.md), 또는 `scripts/self_host_pg_dump.sh`의 덤프.
3. 이미지(digest)만 새 핀으로 바꿔 서비스를 재배포한다. 볼륨·`PGDATA` 경로는 그대로 둔다.
4. 확인: `SHOW server_version;`이 18.6 이상, `SHOW server_version_num;` ≥ 180006, 앱 `/health`, 마이그레이션 상태, `scripts/verify_rls.sh`.
5. 되돌리기: 마이너 다운그레이드는 지원하지 않는다. 문제가 생기면 같은 이미지 계열에서 백업 복원으로 간다.

pgvector 확장 버전은 이미지 태그를 따르지만 기존 DB의 `vector` 확장은 `ALTER EXTENSION vector UPDATE`를 돌리기 전까지 옛 버전으로 남는다. 필요할 때만 따로 판단한다(이 문서의 범위 밖).
