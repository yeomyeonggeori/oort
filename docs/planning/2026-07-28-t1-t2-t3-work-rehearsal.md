# T1 → T2 → T3 Work 리허설 시나리오

> MOMO-647 / ADR-0136 D4. 성재 1인이 같은 개발 goal을 T1, T2, T3에서
> 수행·중단·재개하며 host fabric과 T3 과금 원장을 검증하는 실동 대본이다.
> 자격증명 값, 터미널 원문, 저장소 비밀은 증거에 남기지 않는다.

## 0. 목적과 합격 기준

같은 작은 goal(예: 테스트 하나 추가 후 커밋)을 세 티어에서 이어 수행한다.

- T1: macOS 앱 호스트에서 시작한다.
- T2: 등록된 self-host `workd`에서 이어 수행한다.
- T3: 사용자가 명시적으로 `momo Cloud`를 선택한 뒤 E2B 호스트에서 이어 수행한다.
- 호스트가 살아 있으면 같은 PTY에 재부착한다. 호스트가 죽으면 ADR-0125 D11의
  `orphaned → resume_offer → 새 호스트에서 git 계보 재개` 경로를 사용한다.
- T3의 running 구간만 활성시간에 포함하고 pause 구간은 0초로 계산한다.
- T3 잔액 또는 슬롯이 없으면 생성 전에 사람이 읽을 수 있는 이유로 거부한다.
  T1/T2는 E2B 키나 T3 잔액과 무관하게 계속 동작해야 한다.

## 1. 준비

1. 이 리허설 전용 브랜치와 원격 저장소를 준비하고 시작 SHA를 기록한다.
2. 동일 workspace에 T1 앱 호스트와 T2 `workd`가 online인지 확인한다.
3. work tier policy는 기본 `ask`로 둔다. `auto_target=cloud`는 이 대본에서
   사용하지 않는다. T3 전환은 매번 사용자가 승인 카드에서 직접 선택한다.
4. 운영자가 테스트 workspace에 최소 T3 크레딧과 슬롯 1개를 부여한다.
5. 오케스트레이터가 `E2B_API_KEY`, E2B template, 공개 HTTPS oort server URL,
   cloud `workd` 부트스트랩 명령을 서버 프로세스에만 주입한다. 값을 출력하거나
   클라이언트·workspace 설정·DB·감사 detail에 복제하지 않는다.
6. 아래 표를 복사해 실측 시각과 ID를 기록한다. 시간은 UTC, 지연은 monotonic
   clock 기준으로 잰다.

| 단계 | session/host ID | 요청 시각 | 준비/재개 시각 | 지연 ms | 원장 active s | pause s | 결과 |
|---|---|---:|---:|---:|---:|---:|---|
| T1 시작 |  |  |  |  | 해당 없음 | 해당 없음 |  |
| T1→T2 계보 재개 |  |  |  |  | 해당 없음 | 해당 없음 |  |
| T2 재부착 |  |  |  |  | 해당 없음 | 해당 없음 |  |
| T2→T3 계보 재개 |  |  |  |  |  |  |  |
| T3 pause→resume |  |  |  |  |  |  |  |
| T3 destroy |  |  |  |  |  |  |  |

## 2. T1 — 시작과 안전한 중단

1. T1 호스트를 선택해 goal을 시작하고 `rehearsal/t1.txt`를 만든다.
2. 파일을 커밋하고 SHA를 스레드에 남긴다. 터미널 원문 대신 SHA만 증거로 쓴다.
3. 앱을 닫았다 다시 열어 살아 있는 T1 호스트에 재부착한다.
4. 같은 PTY와 workdir인지 확인하고 **재부착 지연**을 기록한다.
5. 아직 커밋하지 않은 표식 파일을 하나 만든 뒤 T1 호스트를 강제 offline 처리한다.
6. 세션이 `orphaned`가 되고 `resume_offer`가 한 번만 생기는지 확인한다.

합격: 앱 수명만 끝난 3단계에서는 세션이 orphaned가 되지 않고, 실제 host 상실인
5단계에서만 D11 폴백 카드가 나온다.

## 3. T2 — D11 git 계보 재개와 재부착

1. `resume_offer`에서 T2를 명시적으로 선택한다.
2. T2가 원격 브랜치의 T1 SHA에서 checkout하고 새 session의
   `resumed_from_session_id`가 T1 session을 가리키는지 확인한다.
3. T1의 커밋된 파일은 존재하고, 커밋하지 않은 표식 파일은 없음을 확인한다.
   카드가 미커밋 변경 손실 가능성을 고지해야 한다.
4. `rehearsal/t2.txt`를 추가해 커밋하고 SHA를 기록한다.
5. 클라이언트만 닫았다 열어 T2에 재부착하고 지연을 기록한다.
6. T2 `workd`를 offline 처리해 `orphaned`와 새 `resume_offer`를 만든다.

합격: 재부착은 같은 PTY이고, host 사망 뒤 재개는 새 PTY/새 session이되 git
계보와 `resumed_from_session_id`가 이어진다.

## 4. T3 — 명시적 생성, pause 제외, 재개, 종료

1. `resume_offer`에서 **oort Cloud를 직접 선택**한다. 질문 없는 자동 전환이
   일어나지 않았음을 기록한다.
2. 요청부터 E2B create 완료까지 **spawn 지연**, cloud `workd`의 Ed25519
   자기등록과 첫 heartbeat까지 **host 준비 지연**, session running까지의
   **총 준비 지연**을 각각 기록한다.
3. T3가 T2 SHA에서 시작하고 `resumed_from_session_id`가 T2 session을
   가리키는지 확인한다.
4. 30초 이상 작업해 `rehearsal/t3.txt`를 커밋한다. 활성 구간 시작·종료와
   원장의 누적 active seconds를 기록한다.
5. T3를 pause하고 30초 이상 기다린다. E2B 상태와 원장 구간이 `paused`인지,
   이 대기시간 동안 active seconds가 늘지 않는지 확인한다.
6. T3를 resume한다. 요청부터 E2B connect와 host heartbeat/session ready까지의
   **재개 지연**을 기록한다.
7. 20초 이상 작업한 뒤 종료한다. 최종 SHA를 push하고 T3를 destroy한다.
8. 다음 식을 DB 실측값으로 검산한다.

```text
expected_active_seconds =
  Σ floor(ended_at - started_at) for state='active'

ledger_active_seconds = Σ work_host_usage_interval.active_seconds

expected_active_seconds == ledger_active_seconds
credit debit == ledger_active_seconds × configured rate
pause interval overlap with active interval == 0
```

초 단위 경계의 허용 오차는 구간별 내림 때문에 `0..활성 구간 수-1초`다. wall-clock
pause 시간은 어떤 active 구간에도 포함되면 안 된다.

## 5. fail-closed 부정 경로

각 검사는 별도 T3 요청으로 수행하고 기존 running session은 종료하지 않는다.

1. 크레딧을 0으로 만든 뒤 T3 생성이 409로 거부되고, 문구가
   “oort Cloud 크레딧이 없어 시작할 수 없습니다.”처럼 다음 행동을 설명하는지 확인한다.
2. 슬롯을 모두 점유한 뒤 새 T3 생성이 409로 거부되고 현재/최대 슬롯을
   사용자가 읽을 수 있는 문장으로 설명하는지 확인한다.
3. 서버 프로세스에서 `E2B_API_KEY`를 제거한 격리 인스턴스로 T3 생성이 503인지
   확인한다. 같은 인스턴스에서 T1/T2 session 생성은 성공해야 한다.
4. policy를 `ask`로 되돌린 뒤 cloud host를 자동 생성하거나 선택하지 않는지 확인한다.

## 6. 레드 증명과 증거 패킷

1. 격리 검증기 정상 실행 결과를 저장한다.
2. 검증용 복사본에서 pause 종료 시 active 구간을 닫는 SQL/로직을 의도적으로
   제거하고 같은 검증기를 실행한다.
3. `pause 구간 미계상` 단정이 실패하는지 확인한 뒤 복사본을 폐기한다. 이 변형은
   커밋하지 않는다.
4. 최종 패킷에는 브랜치 시작/최종 SHA, tier별 session·host ID, spawn/재개 지연,
   상태 구간과 크레딧 원장 합계, fail-closed HTTP 상태/안전한 오류 문구,
   verifier PASS와 red-proof FAIL 지점만 포함한다.

E2B 키, workd 등록 bearer/개인키, provider credential, PTY 원문은 패킷에
포함하지 않는다.
