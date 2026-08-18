//! 작업 완료 리포트 카드의 **프로듀서** (UXC-A / #1454).
//!
//! #1440 이 이 카드의 소비자 반쪽을 랜딩했다: `packages/momo-core/src/features/
//! timeline/completionReportCard.ts` 가 봉투를 파싱하고, 웹·폰이 그린다. 여기는
//! 그 봉투를 **누가 언제 쓰는가**의 반쪽이다.
//!
//! ## 트리거: 모델이 정하고, 서버는 분류하지 않는다
//!
//! 어떤 턴이 리포트를 받을 자격이 있는지는 **그 턴을 실제로 수행한 쪽**만 안다.
//! 서버는 「30초 넘게 걸렸다」거나 「툴을 세 번 불렀다」 같은 대리 지표로 그것을
//! 추측할 수 있지만, 그런 규칙은 전부 틀린 방향으로 틀린다 — 오래 걸린 잡담에
//! 카드를 세우고, 30초 만에 끝난 마이그레이션에는 세우지 않는다. 그래서 트리거는
//! 모델의 것이다: [`REPORT_PROTOCOL_BLOCK`] 이 매 턴 시스템 맥락에 실려 「여러
//! 단계를 실제로 수행하고 검증 결과가 남는 턴에만」이라는 조건을 말하고, 모델이
//! 답변 끝에 [`REPORT_FENCE_TAG`] 펜스를 붙이면 그 턴이 리포트를 받는다. 펜스가
//! 없으면 오늘까지의 평범한 턴 메시지 그대로다 — 이 파일이 없던 것과 바이트 단위로
//! 같다.
//!
//! ## 저작: 내용은 전부 모델의 것, 서버는 검증·전달만
//!
//! 요약·불릿·게이트 표는 모델이 쓴 그대로 봉투에 실린다. 서버는
//!
//!   * 모양을 검증하고(문자열이 아닌 `text`, 라벨 없는 칸, 칸 없는 표면 줄은 버린다),
//!   * 상한을 지키고(아래 §상한),
//!   * `elapsed_ms` 를 **자기 시계로 덮어쓰고**(모델 자기보고 금지 — `momo-agent` 의
//!     `agent_run.started_at` 에서 재며, 그래서 승인 대기를 건너뛴 턴도 거짓말하지
//!     않는다),
//!   * 기존 여과 계약(`crate::redact_secrets`, ADR-0004)을 한 번 더 통과시킨다
//!
//! 이 넷 말고는 아무것도 하지 않는다. 특히 **게이트 결과 문자열을 정규화하지
//! 않는다**: `"failed"` 를 `"fail"` 로 접는 것도, 모르는 낱말을 `"pass"` 로 추측하는
//! 것도 코어의 일이고(`CHECK_OUTCOME_SYNONYMS` · `unknown` 격), 서버가 그 자리에
//! 끼어들면 「서버가 통과를 지어냈다」가 가능해진다. 여기서 outcome 은 모델이 쓴 낱말
//! 그대로 지나간다(ADR-0132).
//!
//! ## 상한 — 불릿은 자르고, 표는 자르지 않는다
//!
//! 코어의 상한(`MAX_COMPLETION_ACTIONS` 100 · `MAX_COMPLETION_GATE_ROWS` 60 ·
//! `MAX_COMPLETION_CHECKS_PER_ROW` 40)을 프로듀서도 안다. 다만 둘을 다르게 다룬다:
//!
//!   * **불릿**은 상한에서 자른다. 꼬리를 잃어도 남은 불릿이 거짓이 되지는 않는다.
//!   * **게이트 표**는 상한을 넘으면 리포트 자체를 **거절**한다(카드 없이 평범한 턴
//!     메시지로 나간다). 카드 머리의 「완료 / 확인 필요」 칩은 표 **전체**로 계산되므로,
//!     상한에 걸린 꼬리에 `fail` 이 있는데 프로듀서가 그것을 조용히 떨어뜨리면 화면에
//!     「완료」가 서게 된다 — 정직 규율이 막는 바로 그 거짓 서사다. 실제 리포트는
//!     표면 서넛·게이트 여남은이라 이 문은 병적인 봉투에만 닫힌다.
//!
//! ## 펜스는 화면에 남지 않는다
//!
//! 모델이 쓴 펜스 블록은 **답변 본문에서 잘려 나간다**([`visible_prefix`]). 스트리밍
//! 중에도 같은 절단이 적용되므로(`crate::stream::MessageStream`), 읽는 사람은 산문
//! 답변만 보고 그 뒤에 카드가 선다 — 채널에 원시 JSON 이 타이핑되는 순간이 없다.
//! 절단은 JSON 파싱 성공 여부와 무관하다: 성공했을 때만 자르면 깨진 펜스가 스트리밍
//! 중에는 숨었다가 커밋에서 되살아난다.
//!
//! ## 펜스는 답변의 맨 끝이어야 한다 (M-1)
//!
//! 닫는 펜스 뒤에 공백 아닌 것이 하나라도 있으면 그 펜스는 **리포트가 아니다** —
//! [`extract`] 가 [`Extraction::None`] 을 내고 턴 원문이 한 글자도 손상되지 않은 채
//! 나간다. 프로토콜 블록 자신이 「답변 맨 끝에」라고 말하므로 규약과 같은 규칙이고,
//! 한 문장으로 두 갈래의 실결함을 닫는다:
//!
//!   1. **꼬리 산문의 조용한 삭제.** 본문은 펜스 **앞**까지이므로, 모델이 닫는 펜스
//!      뒤에 「추가로, 내일 회의 잡아뒀습니다」를 쓰면 그 문장이 채널에서 사라진다.
//!      이 모듈이 스스로 금지한 「모델이 실제로 쓴 글자를 서버가 지우는 것」이다.
//!   2. **예시의 카드 승격.** 「리포트 카드 어떻게 쓰는 거야?」에 모델이 4-백틱 외곽
//!      펜스로 예시를 보여주면 안쪽 줄이 여는 펜스로 잡히고 예시 JSON 이 파싱된다 —
//!      예시 데이터로 진짜 카드가 서고 본문은 「예시:」에서 잘린다. 외곽 펜스의 닫는
//!      줄이 꼬리에 남으므로 이 규칙이 그것을 거절한다. (외곽을 **안 닫고** 끝낸
//!      답변은 꼬리가 비어 이 문을 통과하므로, `fence_start` 의 펜스 상태 추적이
//!      두 번째 문이다 — M-2·M-4.)
//!
//! **스트리밍과의 정합:** 스트리밍 중에는 미래를 모르므로 절단은 지금 그대로다(펜스
//! 이후를 숨긴다). 꼬리 산문이 뒤늦게 도착하면 커밋이 본문을 다시 써서 숨겼던 글이
//! **되돌아온다**. 이 재출현은 이 파일이 막으려는 깜빡임과 방향이 반대라 원칙과
//! 충돌하지 않는다: 막는 것은 「보여준 글자를 서버가 가져가는 것」이고, 여기서 일어나는
//! 일은 아직 안 보여준 글자가 제자리를 찾는 것이다. 잃는 것은 없다.

use serde_json::{Map, Value};

/// `props.kind` — 코어 `COMPLETION_REPORT_KIND` 와 같은 낱말이어야 한다.
/// (`completionReportCard.ts:53`)
pub const COMPLETION_REPORT_KIND: &str = "completion_report";

/// 모델이 리포트를 감싸는 펜스의 info string: ```` ```oort:report ````.
///
/// 모델이 평범한 답변에서 쓸 일이 없을 만큼 특이해야 한다 — `json` 이었다면 코드
/// 예시를 보여주는 턴마다 카드가 섰을 것이다.
pub const REPORT_FENCE_TAG: &str = "oort:report";

/// 코어 `MAX_COMPLETION_ACTIONS`.
pub const MAX_COMPLETION_ACTIONS: usize = 100;
/// 코어 `MAX_COMPLETION_GATE_ROWS`.
pub const MAX_COMPLETION_GATE_ROWS: usize = 60;
/// 코어 `MAX_COMPLETION_CHECKS_PER_ROW`.
pub const MAX_COMPLETION_CHECKS_PER_ROW: usize = 40;

/// 매 턴 시스템 맥락에 실리는 프로토콜 — 이 카드가 존재하기 위한 유일한 조건.
///
/// 모델이 규약을 모르면 이 모듈 전체가 절대 불리지 않는 코드다. `now_context_block`
/// 과 같은 자리(운영자 프롬프트 뒤, 대화 앞)에 서고, 같은 이유로 예산 트림 밖에 있다.
///
/// 조건절이 길고 구체적인 것은 의도다: 「끝났으니 리포트를 써라」로 두면 인사 한 줄에도
/// 카드가 서고, 그러면 이 카드는 채널의 소음이 된다.
pub const REPORT_PROTOCOL_BLOCK: &str = concat!(
    "작업 완료 리포트(선택):\n",
    "여러 단계를 실제로 수행했고 검증 결과가 남는 턴 — 환경 셋업, 마이그레이션, 대규모 수정처럼 \
     사람이 나중에 감사할 일 — 을 끝냈을 때만 답변 맨 끝에 아래 펜스 블록을 한 번 붙이세요. \
     질문에 답하거나 대화하는 평범한 턴에는 붙이지 마세요.\n",
    "```oort:report\n",
    "{\"title\":\"제목(선택)\",\"summary\":\"한 문단 요약\",",
    "\"actions\":[{\"text\":\"한 일\",\"note\":\"왜(선택)\"}],",
    "\"gates\":[{\"surface\":\"표면\",\"checks\":[{\"label\":\"게이트\",\
     \"outcome\":\"pass|fail|skip|pending\",\"detail\":\"정직한 세부(선택)\"}]}]}\n",
    "```\n",
    "규칙: 블록 앞의 글이 채널에 남는 답변이고 블록 자체는 화면에 보이지 않습니다. \
     gates 에는 실제로 돌려서 결과를 본 것만 적으세요 — 안 돌린 것은 skip, 아직인 것은 pending 이며 \
     통과를 지어내지 마세요. 경과 시간은 서버가 측정하므로 적지 마세요."
);

/// 한 턴에서 뽑아낸 리포트.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionReport {
    /// 채널에 남을 답변 — 펜스가 잘려 나간 본문.
    pub body: String,
    /// 이 리포트가 턴 메시지 `props` 에 얹는 키들. `elapsed_ms` 는 **여기 없다** —
    /// 서버가 커밋 트랜잭션 안에서 자기 시계로 넣는다([`with_elapsed_ms`]).
    pub props: Map<String, Value>,
}

/// 눈에 보이지 않으면서 Rust `trim` 이 공백으로 **보지 않는** 문자들 (M-3).
///
/// `` ```oort:report<U+200B> `` 는 사람 눈에 정상 펜스이고 `str::trim` 에게는 태그가
/// 다른 낱말이다. 그 한 글자가 붙으면 펜스가 열리지 않고, 열리지 않은 펜스의 JSON 은
/// **원시 텍스트로 채널에 실린다** — 이 파일이 막으려는 바로 그 노출이다. 그래서
/// 낱말 비교와 꼬리 검사는 전부 이것을 걷어낸 뒤에 한다.
const ZERO_WIDTH: [char; 4] = ['\u{200B}', '\u{200C}', '\u{200D}', '\u{FEFF}'];

/// 제로폭을 걷어낸 사본. 판정 **전용**.
fn without_zero_width(text: &str) -> String {
    text.chars().filter(|c| !ZERO_WIDTH.contains(c)).collect()
}

/// 판정용 정규화 — 제로폭을 걷어내고 양끝 공백을 자른다.
///
/// **판정에만 쓴다.** 본문과 props 로 나가는 문자열은 모델이 쓴 그대로여야 하므로
/// 여기를 통과시키지 않는다(서버가 모델의 글자를 고쳐 쓰지 않는다).
fn normalized(text: &str) -> String {
    without_zero_width(text).trim().to_string()
}

/// 한 코드펜스의 문법 — 어떤 글자로 몇 개 열렸는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FenceMark {
    /// CommonMark 의 펜스 글자: 백틱(`` ` ``) 또는 물결(`~`). 닫개는 **같은 글자**여야
    /// 한다 — `~~~` 로 연 블록을 ``` ``` ``` 이 닫지 않는다.
    marker: char,
    /// 그 글자가 연달아 몇 개인가. 닫개는 **이만큼 이상**이어야 한다.
    run: usize,
}

/// 여는 펜스가 선 자리와 그 펜스의 문법.
#[derive(Debug, Clone, Copy)]
struct Fence {
    /// 여는 펜스 줄이 시작하는 바이트 위치 — 보이는 본문이 끝나는 자리.
    at: usize,
    mark: FenceMark,
}

/// 이 줄이 코드펜스 줄이면 그 문법과 info string.
///
/// ## 백틱만이 아니라 물결도 센다 (M-4)
///
/// CommonMark 의 코드펜스 글자는 **둘**이다: `` ``` `` 과 `~~~`. 물결을 안 세면 물결로
/// 연 블록이 [`fence_start`] 의 상태 기계에 잡히지 않고, 그 안의 예시 `` ```oort:report ``
/// 줄이 최상위 펜스로 승격된다 — 규약을 설명하는 답변이 자기 예시 데이터로 진짜 카드를
/// 세운다. CommonMark 에 제3의 펜스 문법은 없으므로 이 둘로 이 가족이 완결된다.
///
/// ## 틱을 세기 **전에** 제로폭을 걷어낸다 (M-5)
///
/// 여는 줄이 `` <U+200B>```oort:report `` 이면 첫 글자가 백틱이 아니라 런이 0 이고, 그
/// 줄은 펜스가 아니게 된다 — 그리고 열리지 않은 펜스의 JSON 은 원시 텍스트로 채널에
/// 실린다. 회전 2 는 **태그**만 제로폭에서 지켰고 런 자체는 지키지 않았다. 정규화는
/// 여전히 판정 전용이며, 본문·props 로 나가는 문자열은 원문 그대로다.
///
/// 백틱 펜스의 info 에 백틱이 있으면 CommonMark 상 펜스가 아니다(물결 펜스에는 그
/// 제약이 없다).
fn fence_line(line: &str) -> Option<(FenceMark, String)> {
    let cleaned = without_zero_width(line);
    let trimmed = cleaned.trim_start();
    let marker = match trimmed.chars().next() {
        Some(c @ ('`' | '~')) => c,
        _ => return None,
    };
    let run = trimmed.chars().take_while(|c| *c == marker).count();
    if run < 3 {
        return None;
    }
    let info = trimmed[run..].trim().to_string();
    if marker == '`' && info.contains('`') {
        return None;
    }
    Some((FenceMark { marker, run }, info))
}

impl FenceMark {
    /// 이 펜스를 닫는 줄인가 — 같은 글자, 같거나 더 긴 런, info 없음(CommonMark).
    fn closes(self, other: FenceMark, info: &str) -> bool {
        other.marker == self.marker && other.run >= self.run && info.is_empty()
    }
}

/// 리포트 펜스가 열리는 자리. 없으면 `None`.
///
/// 「줄 맨 앞의 ``` + 태그」만 펜스로 보므로, 모델이 산문 안에서 태그를 언급해도(예:
/// 「oort:report 블록을 붙일까요?」) 그 줄은 펜스가 아니다.
///
/// ## 다른 코드블록 **안**에서는 열리지 않는다 (M-2)
///
/// 이 함수는 마크다운 펜스 상태를 따라간다. 「리포트 카드 어떻게 쓰는 거야?」에 모델이
/// ` ```json ` 이나 4-백틱 블록으로 **규약을 보여주면**, 그 안의 `` ```oort:report ``
/// 줄은 여는 펜스가 아니라 그냥 글자다 — 예시가 진짜 카드가 되면 화면에는 실제로
/// 일어난 적 없는 일의 게이트 표가 선다.
///
/// 회전 1 의 「맨 끝」 규칙은 **닫힌** 외곽만 잡았다(닫는 줄이 꼬리에 남으므로). 외곽을
/// 안 닫고 끝낸 답변은 꼬리가 비어 그 문을 통과했고, 이 상태 추적이 두 경우를 한
/// 기계로 닫는다.
fn fence_start(text: &str) -> Option<Fence> {
    let mut open: Option<FenceMark> = None;
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        if let Some((mark, info)) = fence_line(line) {
            match open {
                // 열린 블록 안이다. 닫개(같은 글자·같거나 더 긴 런·info 없음)만 그것을
                // 닫고, 그 밖의 모든 줄은 — 태그가 붙어 있어도 — 내용이다.
                Some(open_mark) => {
                    if open_mark.closes(mark, &info) {
                        open = None;
                    }
                }
                None => {
                    if info.eq_ignore_ascii_case(REPORT_FENCE_TAG) {
                        let indent = line.len() - line.trim_start().len();
                        return Some(Fence {
                            at: offset + indent,
                            mark,
                        });
                    }
                    open = Some(mark);
                }
            }
        }
        offset += line.len();
    }
    None
}

/// 펜스 앞까지의 본문.
///
/// 여는 펜스가 통째로 도착한 경우에만 자른다. 끝이 ``` 로 끝나는 답변(닫히지 않은
/// 코드 블록)을 펜스로 오인해 잘라내면, 모델이 실제로 쓴 글자를 서버가 지우는 것이 된다.
///
/// **이것만으로는 커밋 본문이 아니다.** 펜스가 답변의 맨 끝인지는 여기서 알 수 없고
/// (닫는 펜스 뒤를 보지 않는다), 그 판정은 [`extract`] 가 진다 — 맨 끝이 아니면
/// 리포트 자체가 없던 일이 되고 본문은 원문 그대로다(모듈 머리말 §맨 끝). 그래서 이
/// 함수는 ①스트리밍 절단의 바탕([`streaming_prefix`])이고 ②맨 끝 규칙을 이미 통과한
/// 봉투의 본문이다.
pub fn visible_prefix(text: &str) -> &str {
    match fence_start(text) {
        Some(fence) => text[..fence.at].trim_end(),
        None => text,
    }
}

/// 스트리밍 중 화면에 보일 본문 — [`visible_prefix`] 에, **쓰여지는 중인 펜스**의
/// 마지막 줄을 더 접은 것.
///
/// 모델이 ```` ```oort:report ```` 를 타이핑하는 동안 그 줄은 아직 펜스가 아니다.
/// 그대로 두면 읽는 사람은 ```` ```oort:re ```` 가 나타났다가 태그가 완성되는 순간
/// 사라지는 것을 본다 — 서버가 글자를 도로 가져가는 그 깜빡임이 이 함수가 막는 것이다.
///
/// 접는 대상은 **마지막 줄이 여는 펜스의 진짜 접두사일 때**뿐이다. `` ```json `` 은
/// 세 번째 글자에서 갈라지므로 한 프레임 뒤 곧바로 다시 보인다.
///
/// 완성된 본문에는 쓰지 않는다: 마지막 줄이 ``` 하나로 끝나는 답변을 영구히 잘라
/// 버리기 때문이다. 그 차이(마지막 한 프레임)는 커밋이 절대 본문을 다시 써서 메운다.
pub fn streaming_prefix(text: &str) -> &str {
    let visible = visible_prefix(text);
    if visible.len() != text.len() {
        // 펜스가 이미 통째로 도착했다 — 그 뒤는 볼 것이 없다.
        return visible;
    }
    let line_start = text.rfind('\n').map(|at| at + 1).unwrap_or(0);
    let tail = &text[line_start..];
    let trimmed = tail.trim_start();
    // 제로폭까지 걷어낸 뒤에 비교한다(M-3): `` ```oort:re<U+200B> `` 도 쓰여지는 중인
    // 펜스이고, 그것을 못 알아보면 한 프레임 동안 글자가 보였다 사라진다.
    let candidate = normalized(trimmed).to_ascii_lowercase();
    if candidate.is_empty() {
        return visible;
    }
    // 두 펜스 글자 모두 (M-4). 판정은 제로폭을 걷어낸 사본으로 하되 잘라내는 위치는
    // 원문 기준이라, `` <U+200B>```oo `` 같은 줄도 통째로 접힌다 (M-5).
    let opens_a_report = ['`', '~']
        .iter()
        .any(|marker| format!("{0}{0}{0}{REPORT_FENCE_TAG}", marker).starts_with(&candidate));
    if opens_a_report {
        return text[..line_start + (tail.len() - trimmed.len())].trim_end();
    }
    visible
}

/// 펜스 안쪽 JSON 문자열과 **닫는 펜스 뒤에 남은 것**.
///
/// 꼬리를 함께 돌려주는 것이 [`extract`] 의 「맨 끝」 규칙이 서는 자리다(모듈 머리말
/// §펜스는 답변의 맨 끝이어야 한다). 닫는 펜스가 없으면(잘린 응답) 남은 전부가
/// payload 이고 꼬리는 비어 있다 — 잘린 응답은 정의상 거기서 끝났으므로 「맨 끝」이
/// 맞고, 파싱은 어차피 실패해 「리포트 없음」으로 정직하게 떨어진다.
fn fence_payload(text: &str, fence: Fence) -> (&str, &str) {
    let after_open = match text[fence.at..].find('\n') {
        Some(newline) => fence.at + newline + 1,
        None => return ("", ""),
    };
    let rest = &text[after_open..];
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        // 닫개는 같은 글자에 여는 펜스만큼 길어야 한다(CommonMark) — 4-백틱으로 연
        // 블록을 3-백틱이 닫지 않고, 물결로 연 블록을 백틱이 닫지 않는다.
        if let Some((mark, info)) = fence_line(line) {
            if fence.mark.closes(mark, &info) {
                return (&rest[..offset], &rest[offset + line.len()..]);
            }
        }
        offset += line.len();
    }
    (rest, "")
}

fn read_string(entry: &Map<String, Value>, key: &str) -> Option<String> {
    match entry.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}

/// 「한 일」 불릿. `text` 가 불릿의 전부이므로 그것이 없는 항목은 버린다 — 코어
/// `parseCompletionActions` 와 같은 판정을, 봉투가 만들어지는 쪽에서 한 번 더.
fn parse_actions(value: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(entries)) = value else {
        return Vec::new();
    };
    let mut actions = Vec::new();
    for raw in entries {
        let Value::Object(entry) = raw else { continue };
        let Some(text) = read_string(entry, "text") else {
            continue;
        };
        let mut action = Map::new();
        action.insert("text".into(), Value::String(text));
        if let Some(note) = read_string(entry, "note") {
            action.insert("note".into(), Value::String(note));
        }
        actions.push(Value::Object(action));
    }
    actions
}

/// 게이트 한 칸. 라벨과 결과 문자열이 **둘 다** 있어야 칸이다.
///
/// `outcome` 은 손대지 않고 그대로 옮긴다(모듈 머리말 §저작). 아는 어휘로 접는 것도,
/// 모르는 낱말을 `unknown` 격으로 남기는 것도 코어의 판정이다.
fn parse_check(raw: &Value) -> Option<Value> {
    let Value::Object(entry) = raw else {
        return None;
    };
    let label = read_string(entry, "label")?;
    let outcome = read_string(entry, "outcome")?;
    if outcome.trim().is_empty() {
        return None;
    }
    let mut check = Map::new();
    check.insert("label".into(), Value::String(label));
    check.insert("outcome".into(), Value::String(outcome));
    if let Some(detail) = read_string(entry, "detail") {
        check.insert("detail".into(), Value::String(detail));
    }
    Some(Value::Object(check))
}

/// 왜 이 봉투가 카드가 되지 못했는가. 호출부가 세는 값이지 사람에게 보이는 문장이
/// 아니다 — 리포트가 없는 턴은 그냥 평범한 턴 메시지이고, 그 사실은 화면에 설명될
/// 일이 아니다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportRefused {
    /// 펜스는 있었는데 JSON 이 아니었다(모델이 잘렸거나 형식을 어겼다).
    Malformed,
    /// 요약도 불릿도 표도 없다. `kind` 만 실린 봉투는 코어도 카드로 세우지 않는다.
    Empty,
    /// 게이트 표가 코어 상한을 넘었다 — 자르면 머리 칩이 거짓말하므로 통째로 거절한다
    /// (모듈 머리말 §상한).
    GatesOverLimit,
}

/// 뽑아낸 결과: 리포트이거나, 왜 아닌가.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Extraction {
    /// 펜스가 아예 없었다 — 이 턴은 오늘까지의 평범한 턴 그대로다.
    None,
    /// 펜스는 있었으나 카드가 되지 못했다. 본문에서 펜스는 여전히 잘려 나간다.
    Refused {
        body: String,
        reason: ReportRefused,
    },
    Report(CompletionReport),
}

/// 모델의 최종 텍스트에서 리포트를 뽑고, 본문에서 펜스를 지운다.
///
/// 불릿을 상한에서 잘랐으면 `usize` 로 몇 개를 잘랐는지 함께 준다(호출부가 로그에만
/// 쓴다 — 본문에는 서버가 쓴 문장이 한 글자도 들어가지 않는다).
pub fn extract(text: &str) -> (Extraction, usize) {
    let Some(fence) = fence_start(text) else {
        return (Extraction::None, 0);
    };
    let (payload, tail) = fence_payload(text, fence);

    // 「맨 끝」 규칙 (M-1). 닫는 펜스 뒤에 공백 아닌 것이 있으면 이것은 리포트가
    // 아니다 — 턴 원문을 한 글자도 건드리지 않고 돌려준다. 모듈 머리말 §펜스는
    // 답변의 맨 끝이어야 한다에 이 문이 막는 두 갈래가 적혀 있다.
    //
    // 제로폭까지 걷어내고 본다(M-3): 꼬리에 U+200B 하나가 남았다고 리포트가 거절되면,
    // 보이지 않는 한 글자가 카드를 통째로 없앤다.
    if !normalized(tail).is_empty() {
        return (Extraction::None, 0);
    }

    let body = visible_prefix(text).to_string();

    let parsed: Value = match serde_json::from_str(payload.trim()) {
        Ok(value) => value,
        Err(_) => {
            return (
                Extraction::Refused {
                    body,
                    reason: ReportRefused::Malformed,
                },
                0,
            );
        }
    };
    let Value::Object(object) = parsed else {
        return (
            Extraction::Refused {
                body,
                reason: ReportRefused::Malformed,
            },
            0,
        );
    };

    let summary = read_string(&object, "summary");
    let all_actions = parse_actions(object.get("actions"));
    let dropped_actions = all_actions.len().saturating_sub(MAX_COMPLETION_ACTIONS);
    let mut actions = all_actions;
    actions.truncate(MAX_COMPLETION_ACTIONS);

    let mut gates: Vec<Value> = Vec::new();
    if let Some(Value::Array(rows)) = object.get("gates") {
        if rows.len() > MAX_COMPLETION_GATE_ROWS {
            return (
                Extraction::Refused {
                    body,
                    reason: ReportRefused::GatesOverLimit,
                },
                0,
            );
        }
        for raw in rows {
            let Value::Object(entry) = raw else { continue };
            let Some(surface) = read_string(entry, "surface") else {
                continue;
            };
            let Some(Value::Array(raw_checks)) = entry.get("checks") else {
                continue;
            };
            if raw_checks.len() > MAX_COMPLETION_CHECKS_PER_ROW {
                return (
                    Extraction::Refused {
                        body,
                        reason: ReportRefused::GatesOverLimit,
                    },
                    0,
                );
            }
            let checks: Vec<Value> = raw_checks.iter().filter_map(parse_check).collect();
            // 칸 없는 표면 줄은 아무것도 말하지 않는다(코어 `parseCompletionGates`).
            if checks.is_empty() {
                continue;
            }
            let mut row = Map::new();
            row.insert("surface".into(), Value::String(surface));
            row.insert("checks".into(), Value::Array(checks));
            gates.push(Value::Object(row));
        }
    }

    if summary.is_none() && actions.is_empty() && gates.is_empty() {
        return (
            Extraction::Refused {
                body,
                reason: ReportRefused::Empty,
            },
            0,
        );
    }

    let mut props = Map::new();
    props.insert(
        "kind".into(),
        Value::String(COMPLETION_REPORT_KIND.to_string()),
    );
    if let Some(title) = read_string(&object, "title") {
        props.insert("title".into(), Value::String(title));
    }
    if let Some(summary) = summary {
        props.insert("summary".into(), Value::String(summary));
    }
    props.insert("actions".into(), Value::Array(actions));
    props.insert("gates".into(), Value::Array(gates));

    (
        Extraction::Report(CompletionReport { body, props }),
        dropped_actions,
    )
}

/// 서버 관측 경과를 리포트 props 에 넣는다.
///
/// `started_at_ms` 는 `agent_run.started_at`(DB 시계), `now_ms` 는 커밋 시점.
/// 음수는 시계가 어긋난 것이므로 키를 아예 넣지 않는다 — 코어가 음수를 그리지 않는
/// 것과 같은 방향이되, 그리지 않을 값을 보내지 않는 쪽이 한 단계 더 정직하다.
pub fn with_elapsed_ms(props: &mut Map<String, Value>, started_at_ms: i64, now_ms: i64) {
    let elapsed = now_ms - started_at_ms;
    if elapsed >= 0 {
        props.insert("elapsed_ms".into(), Value::Number(elapsed.into()));
    }
}

/// 리포트가 이미 봉투에 실려 있는가 — 재청구된 잡이 같은 메시지에 두 번 얹지 않게.
pub fn already_reported(props: &Value) -> bool {
    props.get("kind").and_then(Value::as_str) == Some(COMPLETION_REPORT_KIND)
}

/// 프로듀서가 실은 키들 — 기존 키를 밟지 않고 병합한다.
///
/// 턴 메시지는 이미 `run_id`·`source`·트리거 링크를 싣고 있다(`success_props`).
/// 리포트 키와는 겹치지 않지만, 겹치는 날에 이기는 쪽은 **먼저 쓰인 서버의 사실**이지
/// 모델이 보낸 낱말이 아니다.
pub fn merge_into(target: &mut Value, report: &Map<String, Value>) {
    let Some(object) = target.as_object_mut() else {
        return;
    };
    for (key, value) in report {
        object.entry(key.clone()).or_insert_with(|| value.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn report_of(text: &str) -> CompletionReport {
        match extract(text).0 {
            Extraction::Report(report) => report,
            other => panic!("expected a report, got {other:?}"),
        }
    }

    /// 벤치마크가 잰 그 모양 — 요약 한 문단, 불릿, 표면×게이트 표. 코어 픽스처
    /// `REPORT_PROPS`(`completionReportCard.test.ts:35`)와 같은 봉투가 나와야 한다.
    #[test]
    fn a_fenced_report_becomes_the_envelope_the_core_parses() {
        let report = report_of(
            "환경 셋업을 마쳤습니다.\n\n\
             ```oort:report\n\
             {\"title\":\"셋업 완료\",\"summary\":\"한 트리에 다 있습니다.\",\
               \"actions\":[{\"text\":\"툴체인 올림\",\"note\":\"1.83으로는 빌드 안 됨\"},\
                            {\"text\":\"헬스체크 확인\"}],\
               \"gates\":[{\"surface\":\"웹\",\"checks\":[\
                   {\"label\":\"테스트\",\"outcome\":\"pass\",\"detail\":\"896 통과\"}]}]}\n\
             ```",
        );
        assert_eq!(report.body, "환경 셋업을 마쳤습니다.");
        assert_eq!(report.props["kind"], json!(COMPLETION_REPORT_KIND));
        assert_eq!(report.props["title"], json!("셋업 완료"));
        assert_eq!(report.props["summary"], json!("한 트리에 다 있습니다."));
        assert_eq!(
            report.props["actions"],
            json!([
                {"text": "툴체인 올림", "note": "1.83으로는 빌드 안 됨"},
                {"text": "헬스체크 확인"}
            ])
        );
        assert_eq!(
            report.props["gates"],
            json!([{"surface": "웹", "checks": [
                {"label": "테스트", "outcome": "pass", "detail": "896 통과"}
            ]}])
        );
        // 경과는 서버 것이다 — 모델이 보낸 값이든 아니든 여기서는 실리지 않는다.
        assert!(report.props.get("elapsed_ms").is_none());
    }

    /// **트리거의 심장.** 펜스가 없는 턴은 오늘까지의 턴 그대로여야 한다. 이것이
    /// 빨개지면 이 기능은 모든 대화에 카드를 세우는 기능이 된 것이다.
    #[test]
    fn a_turn_without_the_fence_is_untouched() {
        let (extraction, dropped) = extract("안녕하세요. 무엇을 도와드릴까요?");
        assert_eq!(extraction, Extraction::None);
        assert_eq!(dropped, 0);
        assert_eq!(
            visible_prefix("안녕하세요. 무엇을 도와드릴까요?"),
            "안녕하세요. 무엇을 도와드릴까요?"
        );
    }

    /// 산문 안에서 태그를 **언급**하는 것과 펜스를 **여는** 것은 다르다. 줄 맨 앞의
    /// ``` 만 펜스이므로, 규약을 설명하는 답변이 자기 자신을 리포트로 만들지 않는다.
    #[test]
    fn mentioning_the_tag_in_prose_opens_nothing() {
        let text = "oort:report 블록을 붙이면 카드가 섭니다. ```oort:report 처럼요.";
        assert_eq!(extract(text).0, Extraction::None);
        assert_eq!(visible_prefix(text), text);
    }

    /// 다른 언어의 코드 펜스는 리포트가 아니다 — 코드를 보여주는 턴마다 카드가 서면
    /// 이 카드는 소음이 된다.
    #[test]
    fn an_ordinary_code_fence_is_not_a_report() {
        let text = "이렇게 쓰세요:\n```json\n{\"summary\":\"안녕\"}\n```";
        assert_eq!(extract(text).0, Extraction::None);
    }

    /// **서버는 통과를 지어내지 않는다.** 모르는 결과 낱말도, 실패 동의어도 손대지
    /// 않고 그대로 지나간다 — 접는 것도 `unknown` 으로 남기는 것도 코어의 판정이다.
    /// 여기서 정규화를 시작하면 「서버가 pass 를 만들었다」가 가능한 코드가 된다.
    #[test]
    fn outcome_words_pass_through_verbatim() {
        let report = report_of(
            "끝.\n```oort:report\n\
             {\"gates\":[{\"surface\":\"엔진\",\"checks\":[\
                {\"label\":\"테스트\",\"outcome\":\"FAILED\"},\
                {\"label\":\"린트\",\"outcome\":\"초록\"},\
                {\"label\":\"빌드\",\"outcome\":\"skipped\"}]}]}\n```",
        );
        let checks = report.props["gates"][0]["checks"].clone();
        assert_eq!(checks[0]["outcome"], json!("FAILED"));
        assert_eq!(checks[1]["outcome"], json!("초록"));
        assert_eq!(checks[2]["outcome"], json!("skipped"));
    }

    /// 모양이 아닌 항목은 버린다 — 라벨 없는 칸, 결과 없는 칸, 글자 없는 불릿,
    /// 칸이 하나도 남지 않은 표면 줄.
    #[test]
    fn shapeless_entries_are_dropped_not_guessed() {
        let report = report_of(
            "끝.\n```oort:report\n\
             {\"summary\":\"요약\",\
               \"actions\":[{\"note\":\"글자 없음\"},{\"text\":\"진짜\"},\"문자열\"],\
               \"gates\":[{\"surface\":\"빈 줄\",\"checks\":[{\"label\":\"결과없음\"}]},\
                          {\"checks\":[{\"label\":\"표면없음\",\"outcome\":\"pass\"}]},\
                          {\"surface\":\"엔진\",\"checks\":[{\"outcome\":\"pass\"},\
                            {\"label\":\"빌드\",\"outcome\":\"pass\"}]}]}\n```",
        );
        assert_eq!(report.props["actions"], json!([{"text": "진짜"}]));
        assert_eq!(
            report.props["gates"],
            json!([{"surface": "엔진", "checks": [{"label": "빌드", "outcome": "pass"}]}]),
            "칸 없는 줄과 표면 없는 줄은 표에 서지 않는다"
        );
    }

    /// 불릿은 상한에서 자른다(남은 것이 거짓이 되지 않는다), 표는 자르지 않고
    /// 리포트를 거절한다(잘린 꼬리의 fail 이 머리 칩을 「완료」로 뒤집는다).
    #[test]
    fn bullets_are_clamped_and_an_oversized_table_refuses_the_whole_card() {
        let bullets: Vec<Value> = (0..MAX_COMPLETION_ACTIONS + 7)
            .map(|i| json!({"text": format!("일 {i}")}))
            .collect();
        let text = format!(
            "끝.\n```oort:report\n{}\n```",
            json!({"summary": "요약", "actions": bullets})
        );
        let (extraction, dropped) = extract(&text);
        let Extraction::Report(report) = extraction else {
            panic!("bullets clamp rather than refuse");
        };
        assert_eq!(
            report.props["actions"].as_array().unwrap().len(),
            MAX_COMPLETION_ACTIONS
        );
        assert_eq!(dropped, 7);

        let rows: Vec<Value> = (0..MAX_COMPLETION_GATE_ROWS + 1)
            .map(|i| json!({"surface": format!("표면 {i}"), "checks": [{"label": "빌드", "outcome": "pass"}]}))
            .collect();
        let text = format!(
            "끝.\n```oort:report\n{}\n```",
            json!({"summary": "요약", "gates": rows})
        );
        assert!(matches!(
            extract(&text).0,
            Extraction::Refused {
                reason: ReportRefused::GatesOverLimit,
                ..
            }
        ));

        let checks: Vec<Value> = (0..MAX_COMPLETION_CHECKS_PER_ROW + 1)
            .map(|i| json!({"label": format!("게이트 {i}"), "outcome": "pass"}))
            .collect();
        let text = format!(
            "끝.\n```oort:report\n{}\n```",
            json!({"gates": [{"surface": "웹", "checks": checks}]})
        );
        assert!(matches!(
            extract(&text).0,
            Extraction::Refused {
                reason: ReportRefused::GatesOverLimit,
                ..
            }
        ));
    }

    /// `kind` 만 실린 봉투는 카드가 아니다 — 코어도 `null` 을 낸다. 프로듀서가 그런
    /// 봉투를 보내면 화면에는 빈 카드가 아니라 평범한 턴이 서야 한다.
    #[test]
    fn a_report_with_nothing_in_it_is_refused() {
        assert!(matches!(
            extract("끝.\n```oort:report\n{}\n```").0,
            Extraction::Refused {
                reason: ReportRefused::Empty,
                ..
            }
        ));
    }

    /// **깨진 펜스도 본문에서 잘린다.** 파싱에 성공했을 때만 자르면, 스트리밍 중에는
    /// 숨었던 JSON 조각이 커밋에서 되살아나 글자가 나타났다 사라진다.
    #[test]
    fn a_malformed_fence_still_leaves_the_prose_alone() {
        let (extraction, _) = extract("답변입니다.\n```oort:report\n{\"summary\": 잘림");
        assert_eq!(
            extraction,
            Extraction::Refused {
                body: "답변입니다.".to_string(),
                reason: ReportRefused::Malformed,
            }
        );
    }

    /// 스트리밍 슬라이스와 커밋 본문은 **같은 절단**을 본다. 갈라지면 읽는 사람
    /// 눈앞에서 글자가 나타났다 사라진다.
    ///
    /// 펜스가 **쓰여지는 중**인 프레임까지 포함해서다: `` ```oort:re `` 가 잠깐
    /// 보였다가 태그가 완성되며 사라지면, 그것이 정확히 「서버가 글자를 도로
    /// 가져가는」 깜빡임이다.
    #[test]
    fn the_streaming_cut_and_the_committed_body_agree() {
        let full = "산문 답변.\n\n```oort:report\n{\"summary\":\"요약\"}\n```";
        for frame in [
            "산문 답변.\n\n`",
            "산문 답변.\n\n```",
            "산문 답변.\n\n```oort:re",
            "산문 답변.\n\n```oort:report",
            "산문 답변.\n\n```oort:report\n{",
            full,
        ] {
            assert_eq!(streaming_prefix(frame), "산문 답변.", "frame: {frame:?}");
        }
        assert_eq!(visible_prefix(full), "산문 답변.");
        assert_eq!(report_of(full).body, "산문 답변.");
    }

    /// **M-1 갈래 1 — 꼬리 산문은 삭제되지 않는다.**
    ///
    /// 본문은 펜스 **앞**까지이므로, 닫는 펜스 뒤의 문장을 되붙이는 코드는 없다.
    /// 맨 끝 규칙이 없으면 「추가로, 내일 회의 잡아뒀습니다」가 채널에서 조용히
    /// 사라진다 — 이 모듈이 스스로 금지한 「모델이 쓴 글자를 서버가 지우는 것」이다.
    /// 규칙을 되돌리면 이 단정이 카드를 받고 빨개진다.
    #[test]
    fn prose_after_the_closing_fence_keeps_the_whole_answer() {
        let text = "환경 셋업을 마쳤습니다.\n\n\
             ```oort:report\n\
             {\"summary\":\"요약\",\"gates\":[{\"surface\":\"웹\",\
               \"checks\":[{\"label\":\"테스트\",\"outcome\":\"pass\"}]}]}\n\
             ```\n\
             추가로, 내일 회의 잡아뒀습니다.";
        let (extraction, dropped) = extract(text);
        assert_eq!(
            extraction,
            Extraction::None,
            "a fence that is not the last thing in the answer is not a report"
        );
        assert_eq!(dropped, 0);
        assert!(
            matches!(extraction, Extraction::None),
            "and the turn goes out byte for byte — the caller keeps `completion.text`"
        );
        assert!(
            text.ends_with("추가로, 내일 회의 잡아뒀습니다."),
            "the sentence the old code deleted is still the end of the turn"
        );
    }

    /// **M-1 갈래 2 — 외곽 코드블록 안의 예시는 카드가 되지 않는다.**
    ///
    /// 「리포트 카드 어떻게 쓰는 거야?」에 모델이 4-백틱 외곽 펜스로 규약을 보여주면,
    /// 안쪽 줄이 여는 펜스로 잡히고 안쪽 ``` 이 닫는 펜스로 잡혀 **예시 데이터로
    /// 진짜 카드가 선다**. 외곽 펜스의 닫는 줄이 꼬리에 남는 것이 그것을 막는다.
    #[test]
    fn an_example_inside_an_outer_code_block_is_not_a_card() {
        let text = "이렇게 씁니다:\n\
             ````\n\
             ```oort:report\n\
             {\"summary\":\"예시 요약\",\"actions\":[{\"text\":\"예시\"}]}\n\
             ```\n\
             ````\n\
             질문 더 있으면 말씀하세요.";
        assert_eq!(
            extract(text).0,
            Extraction::None,
            "an example is documentation, not a report of work that happened"
        );

        // 꼬리가 외곽 펜스 하나뿐이어도(뒤에 산문이 없어도) 마찬가지다.
        let closed = "이렇게 씁니다:\n````\n```oort:report\n{\"summary\":\"예시\"}\n```\n````";
        assert_eq!(extract(closed).0, Extraction::None);
    }

    /// **M-2 — 안 닫힌 외곽 펜스 안의 예시도 카드가 되지 않는다.**
    ///
    /// 회전 1 의 「맨 끝」 규칙은 외곽이 **닫혔을 때**만 잡는다(닫는 줄이 꼬리에
    /// 남으므로). 모델이 ` ```json ` 을 열고 규약 예시를 보인 뒤 외곽을 안 닫고
    /// 끝내면 꼬리가 비어 그 문을 통과했다 — 예시 데이터로 진짜 카드가 섰다.
    /// `fence_start` 의 펜스 상태 추적이 그 두 번째 문이다.
    #[test]
    fn an_example_inside_an_unclosed_outer_fence_is_not_a_card() {
        let text = "규약은 이렇습니다:\n\
             ```json\n\
             ```oort:report\n\
             {\"summary\":\"예시 요약\",\"gates\":[{\"surface\":\"웹\",\
               \"checks\":[{\"label\":\"테스트\",\"outcome\":\"pass\"}]}]}\n\
             ```\n";
        assert_eq!(
            extract(text).0,
            Extraction::None,
            "the outer ```json never closed, so the tag line is content — not a fence"
        );

        // markdown 블록도 같다(문서를 보여주는 가장 흔한 모양).
        let markdown = "이렇게 쓰세요:\n```markdown\n```oort:report\n{\"summary\":\"예시\"}\n```\n";
        assert_eq!(extract(markdown).0, Extraction::None);
    }

    /// 상태 추적이 **진짜 리포트를 막지는 않는다**: 답변 안에 평범한 코드블록이
    /// 있고(열고 닫고) 그 뒤 최상위에서 펜스가 열리면 그것은 리포트다.
    #[test]
    fn a_closed_code_block_earlier_in_the_answer_does_not_swallow_the_report() {
        let text = "이 스크립트를 넣었습니다:\n\
             ```sh\n\
             cargo test\n\
             ```\n\
             그리고 게이트를 돌렸습니다.\n\
             ```oort:report\n\
             {\"summary\":\"전부 초록\"}\n\
             ```";
        let Extraction::Report(report) = extract(text).0 else {
            panic!("a top-level fence after a closed block is a real report")
        };
        assert_eq!(report.props["summary"], json!("전부 초록"));
        assert!(
            report.body.starts_with("이 스크립트를 넣었습니다:")
                && report.body.ends_with("그리고 게이트를 돌렸습니다."),
            "the prose — code block and all — survives: {:?}",
            report.body
        );
    }

    /// **M-4 — 물결 펜스도 상태 기계 안이다.**
    ///
    /// CommonMark 의 펜스 글자는 둘(`` ``` `` · `~~~`)인데 상태 기계가 백틱만 셌다.
    /// 물결로 감싼 예시를 **안 닫고** 끝내면 안쪽 `` ```oort:report `` 가 최상위로
    /// 승격되고, 예시의 ``` 닫개 뒤 꼬리가 비어 「맨 끝」 규칙도 통과했다 — 규약을
    /// 설명하는 답변이 자기 예시 데이터로 진짜 카드를 세운다.
    #[test]
    fn an_example_inside_an_unclosed_tilde_fence_is_not_a_card() {
        let text = "규약은 이렇습니다:\n\
             ~~~\n\
             ```oort:report\n\
             {\"summary\":\"예시 요약\",\"gates\":[{\"surface\":\"웹\",\
               \"checks\":[{\"label\":\"테스트\",\"outcome\":\"pass\"}]}]}\n\
             ```\n";
        assert_eq!(
            extract(text).0,
            Extraction::None,
            "the tilde block never closed, so the tag line is content — not a fence"
        );

        // 물결에 info 를 단 형태도 같다(`~~~markdown`).
        let labelled = "예시:\n~~~markdown\n```oort:report\n{\"summary\":\"예시\"}\n```\n";
        assert_eq!(extract(labelled).0, Extraction::None);
    }

    /// 물결 블록을 **닫은 뒤**의 진짜 리포트는 통과한다 — 닫개는 같은 글자여야 하므로
    /// (CommonMark), 백틱이 물결 블록을 닫아 버리거나 그 반대가 되면 안 된다.
    #[test]
    fn a_closed_tilde_block_does_not_swallow_the_report_that_follows() {
        let text = "설정 파일입니다:\n\
             ~~~yaml\n\
             key: value\n\
             ~~~\n\
             적용했습니다.\n\
             ```oort:report\n\
             {\"summary\":\"적용 완료\"}\n\
             ```";
        let Extraction::Report(report) = extract(text).0 else {
            panic!("a top-level fence after a closed tilde block is a real report")
        };
        assert_eq!(report.props["summary"], json!("적용 완료"));
        assert!(report.body.ends_with("적용했습니다."), "{:?}", report.body);

        // 백틱은 물결 블록을 닫지 못한다: 아래에서 ``` 는 여전히 블록 안의 글자이고,
        // 그래서 그 뒤의 태그 줄도 최상위가 아니다.
        let mismatched = "예시:\n~~~\n```\n```oort:report\n{\"summary\":\"예시\"}\n```\n";
        assert_eq!(extract(mismatched).0, Extraction::None);
    }

    /// **M-5 — 틱 런 앞의 제로폭이 펜스 인식 자체를 무산시키지 못한다.**
    ///
    /// 회전 2 는 **태그**를 제로폭에서 지켰지만 런 자체는 지키지 않았다: 여는 줄이
    /// `` <U+200B>```oort:report `` 이면 첫 글자가 백틱이 아니라 런이 0 이고, 그 줄은
    /// 펜스가 아니게 되어 원시 JSON 이 본문으로 커밋된다.
    #[test]
    fn zero_width_before_the_tick_run_cannot_hide_the_fence() {
        for invisible in ["\u{200B}", "\u{200C}", "\u{200D}", "\u{FEFF}"] {
            // 런 앞, 그리고 런 **안**.
            for line in [
                format!("{invisible}```oort:report"),
                format!("``{invisible}`oort:report"),
            ] {
                let text = format!("끝났습니다.\n{line}\n{{\"summary\":\"요약\"}}\n```");
                let Extraction::Report(report) = extract(&text).0 else {
                    panic!("a zero-width char must not un-make the fence ({line:?})")
                };
                assert_eq!(report.body, "끝났습니다.");
                assert!(
                    !report.body.contains("oort:report") && !report.body.contains("summary"),
                    "the envelope reached the channel as text ({line:?})"
                );
                // 스트리밍도 같은 줄을 접는다 — 커밋과 갈라지면 글자가 깜빡인다.
                assert_eq!(
                    streaming_prefix(&format!("끝났습니다.\n{line}")),
                    "끝났습니다."
                );
            }
        }
    }

    /// **M-3 — 제로폭 문자가 태그 검출을 우회하지 못한다.**
    ///
    /// `` ```oort:report<U+200B> `` 는 사람 눈에 정상 펜스이고 `str::trim` 에게는
    /// 다른 낱말이다. 못 알아보면 펜스가 안 열리고 **원시 JSON 이 채널 본문으로**
    /// 나간다 — 이 파일이 막으려는 바로 그 노출이다. 꼬리의 제로폭도 마찬가지로,
    /// 보이지 않는 한 글자가 카드를 통째로 없애면 안 된다.
    #[test]
    fn zero_width_characters_cannot_smuggle_the_envelope_into_the_body() {
        for invisible in ["\u{200B}", "\u{200C}", "\u{200D}", "\u{FEFF}"] {
            let text =
                format!("끝났습니다.\n```oort:report{invisible}\n{{\"summary\":\"요약\"}}\n```");
            let Extraction::Report(report) = extract(&text).0 else {
                panic!("a zero-width char must not stop the fence from opening ({invisible:?})")
            };
            assert_eq!(report.body, "끝났습니다.");
            assert!(
                !report.body.contains("oort:report") && !report.body.contains("summary"),
                "the envelope must never reach the channel as text"
            );

            // 꼬리에 붙은 제로폭은 「맨 끝」을 깨지 않는다.
            let trailing =
                format!("끝났습니다.\n```oort:report\n{{\"summary\":\"요약\"}}\n```\n{invisible}");
            assert!(
                matches!(extract(&trailing).0, Extraction::Report(_)),
                "an invisible char in the tail must not delete the card ({invisible:?})"
            );
        }
    }

    /// 맨 끝 규칙은 **공백만**을 허용한다: 진짜 리포트가 개행 하나 때문에 거절되면
    /// 안 되고, 문장 하나 때문에는 거절되어야 한다.
    #[test]
    fn only_whitespace_may_follow_the_closing_fence() {
        let with_trailing_blanks = "끝.\n```oort:report\n{\"summary\":\"요약\"}\n```\n\n   \n";
        assert!(matches!(
            extract(with_trailing_blanks).0,
            Extraction::Report(_)
        ));

        let with_a_period = "끝.\n```oort:report\n{\"summary\":\"요약\"}\n```\n.";
        assert_eq!(extract(with_a_period).0, Extraction::None);
    }

    /// 다른 코드 펜스는 한 프레임 뒤 곧바로 다시 보인다 — 세 번째 글자에서 갈라지므로.
    /// 그리고 **완성된** 본문에서는 절대 잘리지 않는다: 닫히지 않은 코드 블록으로
    /// 끝나는 답변의 마지막 ``` 를 영구히 지우면 모델이 쓴 글자를 서버가 삭제한 것이다.
    #[test]
    fn an_ordinary_fence_reappears_and_a_finished_body_is_never_cut() {
        assert_eq!(streaming_prefix("보세요:\n```json"), "보세요:\n```json");
        assert_eq!(
            visible_prefix("코드:\n```rust\nfn main() {}\n```"),
            "코드:\n```rust\nfn main() {}\n```"
        );
    }

    /// 경과는 서버 시계로만 들어가고, 음수(시계 어긋남)는 아예 실리지 않는다.
    #[test]
    fn elapsed_is_the_servers_clock_and_never_negative() {
        let mut props = Map::new();
        with_elapsed_ms(&mut props, 1_000, 1_468_000 + 1_000);
        assert_eq!(props["elapsed_ms"], json!(1_468_000));

        let mut backwards = Map::new();
        with_elapsed_ms(&mut backwards, 5_000, 1_000);
        assert!(backwards.get("elapsed_ms").is_none());
    }

    /// 병합은 기존 키를 밟지 않는다 — 턴이 이미 실은 `run_id`·`source` 는 서버의
    /// 사실이고, 모델이 같은 낱말을 보냈다고 그것이 이기지 않는다.
    #[test]
    fn merging_never_overwrites_what_the_turn_already_said() {
        let mut target = json!({"run_id": "server-run", "source": "agent_worker.final_text.v0"});
        let mut report = Map::new();
        report.insert("kind".into(), json!(COMPLETION_REPORT_KIND));
        report.insert("run_id".into(), json!("model-run"));
        merge_into(&mut target, &report);
        assert_eq!(target["run_id"], json!("server-run"));
        assert_eq!(target["kind"], json!(COMPLETION_REPORT_KIND));
        assert!(already_reported(&target));
        assert!(!already_reported(
            &json!({"source": "agent_worker.final_text.v0"})
        ));
    }
}
