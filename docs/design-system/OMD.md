# OmD v2 운영 경계

> `docs/design-system/README.md`가 오르트 구름의 **사람·리뷰 정본**이고,
> `clients/web/src/design/tokens.css`가 웹 토큰의 **코드 정본**이다. 루트
> `DESIGN.md`와 `.omd/system/*`는 이 둘을 OmD가 읽는 Core v2 형식으로 사상한
> **비권위 mirror**다. OmD 채택은 정본 교체가 아니다.

## 설치 스코프와 채널

- 스코프: 이 저장소에만 적용되는 project-local 설치.
- 채널: Claude Code 하나. `.claude/skills/omd-*`, `.claude/agents/omd-*`,
  `.claude/data`, `.claude/hooks`, `.claude/settings.json`이 OmD 관리 파일이다.
- 기존 `.claude/skills/momo-design-taste*`와 `.claude/agents/design-review.md`는
  프로젝트 소유 파일이다. OmD의 `update`나 `install-skills --force`로 덮어쓰지 않는다.
- Codex·OpenCode·Cursor 채널은 채택하지 않았다. 설치되지 않은 채널을 ready라고
  보고하지 않는다.
- OmD 관리 파일과 `.omd/` 생성물은 **레포에 버전관리하지 않는다**(#1689 스코프
  판정, `.gitignore`). 이 저장소가 버전관리하는 것은 정본 문서와 mirror 문서
  (`DESIGN.md`, 이 문서)뿐이다. 새 클론에서는 `omd` CLI로 채널을 다시 설치하고
  아래 재사상 절차로 `.omd/system/*`을 재생성한다.

## 권위와 역할

| 층 | 하는 일 | 하지 않는 일 |
|---|---|---|
| `tokens.css` · 폰 `tokens.ts` · 코어 토큰 | 실제 제품 값을 정의하고 테스트가 읽는 코드 정본 | DESIGN.md의 사본 값을 따라 자동 변경하지 않음 |
| `docs/design-system/README.md` | 규칙, 근거, 강제 기제와 무검사 영역을 설명하는 정본 | OmD 내부 포맷을 정본으로 삼지 않음 |
| 루트 `DESIGN.md` | 다른 도구에 붙여도 읽히는 Portable Core v2 mirror | 새 토큰·새 규칙·새 제품 사실을 발명하지 않음 |
| `.omd/system/*` | book용 구조화 토큰·대비·상태·결정과 무손실 migration ledger | canonical authority가 아님(`migration-candidate`, `non-authoritative`) |
| `momo-design-taste` · `-web` | 표면을 웹/데스크톱 또는 폰 방언으로 라우팅하고 구현 문법을 정함 | OmD의 범용 취향으로 대체되지 않음 |
| `design-review` | 오르트 구름과 실제 캡처를 근거로 최종 UI 리뷰(Blocker 0, High 0) | 같은 구현 컨텍스트에서 자기 리뷰하지 않음 |
| OmD `omd:designer-review` · `omd:feel` · `omd:final-qa` | 범용 휴리스틱과 보조 검산 | 프로젝트 전용 design-review 판정이나 로컬 게이트를 대체하지 않음 |
| `scripts/design_preflight_web.sh` | 웹·공유 코어의 토큰/카피/AI-Tells 하드 제로 검사 | 빈·로딩·오류·오프라인 완결이나 렌더 위계를 증명하지 않음 |

적용 우선순위는 직접 범위 지시 → 리포지터리 사실과 Accepted ADR → 코드·문서 정본
→ Core v2 mirror → OmD 범용 참고 순이다. 서로 어긋나면 mirror를 정본에 맞춰 고치며,
정본을 mirror에 맞춰 조용히 바꾸지 않는다.

## DESIGN.md와 migration ledger

`DESIGN.md`는 Core v2의 일곱 semantic anchor를 갖고 독립적으로 검증된다. 구조화
graph는 book을 위해 같은 결정을 토큰·대비 쌍·컴포넌트 상태·provenance로 제공한다.
manifest의 canonical은 `source-design-md`, source path는
`docs/design-system/README.md`, status는 `non-authoritative`다. graph를
`portable-core` authority로 `adopt`하는 것은 디자인 시스템 정본 변경이므로 별도
성재 승인과 OmD의 exact owner checkpoint 없이는 하지 않는다.

정본을 바꾼 뒤에는 같은 변경에서 다음을 수행한다.

1. `tokens.css`와 README의 결정·근거를 먼저 갱신하고 기존 디자인 테스트를 통과시킨다.
2. README를 새 임시 디렉터리에 `omd design-md migrate`하여 `dropped=0`과 원문
   재구성 일치를 확인한다.
3. 구조화 graph와 Core v2 projection을 함께 다시 사상하고 source hash·artifact hash를
   갱신한다. 사상 결과가 정본에 없는 결정을 만들지 않았는지 리뷰한다.
4. 아래 정적 검증을 다시 실행한다.

```bash
omd design-md validate DESIGN.md
omd doctor --dir .
scripts/design_preflight_web.sh
```

## Book

book은 로컬 읽기 전용 브라우저다. `.omd/system/graph.json`에서 토큰과 결정의 연결,
선언한 대비 쌍의 실측, 컴포넌트 상태 매트릭스를 보여 준다. book이 PASS를 표시해도
그것은 graph에 **선언된 쌍**만 잰 결과이며, 오르트 구름 §5.3의 사람 검사를 닫지 않는다.

```bash
omd book --dir . --port 6060
```

기본 주소는 `http://localhost:6060/`이다. 포트가 사용 중이면 CLI가 다음 빈 포트를
선택하므로 실제 stdout의 URL을 전달한다. 브라우저 자동화·Docker·제품 런타임과는
독립이며, 정적 handoff가 필요하면 `omd book --dir . --static <output-dir>`를 쓴다.

## UI 작업의 실제 완료 경로

1. `momo-design-taste`가 표면을 라우팅한다.
2. 웹/데스크톱은 `momo-design-taste-web`, 폰은 README와 `tokens.ts`를 따른다.
3. 모든 새 표면은 빈·로딩·오류·오프라인을 갖고, 토스트 대신 맥락 안 인라인 상태를 쓴다.
4. 웹은 `scripts/design_preflight_web.sh`를 통과한다. 폰에는 같은 이름의 프리플라이트가
   없으므로 테스트 결과와 그 공백을 둘 다 보고한다.
5. 실제 캡처가 있는 fresh-context `design-review`가 Blocker 0, High 0을 판정한다.
   OmD 리뷰는 이 경로 앞뒤의 보조 증거일 뿐 합격 도장 자체가 아니다.
