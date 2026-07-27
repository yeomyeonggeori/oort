# MOMO-646 한국어 ASR 실측 결과

> 상태: 오케스트레이터 실측 대기. 이 문서는 결과 기입 템플릿이며 모델을
> 확정하지 않는다.

## 재현 정보

- 코퍼스/참조 전사 버전:
- 실행 호스트 CPU/메모리:
- faster-whisper: `1.2.1` / commit
  `65882eee9f5cdbeeb2d877f1131d48cf241b327d`
- 모델 lock: `scripts/transcription/model-lock.json`
- 디코딩: Korean, beam=5, temperature=0, VAD=false
- CER: NFKC + lowercase + 문자/숫자만(공백·문장부호 제외)
- RTF: 처리시간 ÷ 오디오 길이(1.0 미만이면 실시간보다 빠름)

## 결과

| 모델 | 모델 커밋 | 스레드 | 오디오 길이 | 처리시간 | RTF | CER | 판정 |
|---|---|---:|---:|---:|---:|---:|---|
| small | `536b0662742c02347bc0e980a01041f333bce120` |  |  |  |  |  |  |
| medium | `08e178d48790749d25932bbc082711ddcfdfbc4f` |  |  |  |  |  |  |
| large-v3-turbo | `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf` |  |  |  |  |  |  |

## 참고 기준선(판정 근거 아님)

- Mattermost 공개 실측: 10분 통화, 1스레드에서 tiny 약 2분 20초,
  small 약 16분 50초.
- large-v3의 KsponSpeech 낭독체 CER 참고값: 11.13%.
- 위 두 값은 이번 코퍼스·하드웨어와 조건이 다르므로 이번 표의 대체값으로
  쓰지 않는다.

## 성재/오케스트레이터 판정

- 선택 모델:
- 선택 근거:
- 허용 스레드/동시 job 상한:
- 추가 실측 또는 보류:
