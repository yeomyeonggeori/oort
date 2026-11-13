// Program status reports (#5579, ADR-0190 D4-b 증보 #5578): what a harness
// says about itself *in band*, through the terminal it draws in.
//
//   harness ──ESC ] 7501 ; state=…:kind=… ST──▶ PTY ──▶ pty.rs `read_loop`
//          ──the same bytes, untouched──▶ webview (xterm ignores OSC 7501)
//          ──this scanner──▶ closed `PaneSignal` ──▶ the pane's `on_signal`
//
// This is the **only** module that reads PTY output, and it reads one thing:
// OSC 7501, the Program Status Protocol (revision 0.4, 2026-10-10; kitty
// `docs/misc-protocol.rst`). Codex writes it (`codex-rs/tui/src/
// terminal_program_status.rs`, `state=…:app=codex[:kind=…]` + ST). Claude
// Code writes it too (`state=…:app=claude-code[:…]` + BEL), but only to a
// terminal that answers its feature-detection query `OSC 7501 ; ?`. A harness
// pane answers it (#5586): this module says a query came (`Seen::Query`) and
// `pty.rs` queues `REPLY`, fixed bytes, behind the person's keystrokes.
//
// Every other byte (text, titles, other OSCs, CSI) passes by without being
// kept or forwarded. Of a 7501 report this module reads `state`, `kind`,
// whether an `id` is present, and whether `app` names the pane's harness:
// words from closed lists. `title` and `msg` are base64 text and are skipped
// unread, like any other key. What leaves is a `Report` of two enums, or the
// bare fact of a query; `app` is compared and never kept or shown. Nothing
// read here goes into `REPLY`. `shell_contract.rs` pins all of this by source.
//
// The boundary, in the order a byte meets it:
//
// 1. **Which panes.** Harness panes only (`SpawnPlan::hooks`). There the
//    reporting program *is* the pane's process, so a report cannot outlive
//    it: when it exits the pane shows its lifecycle (끝남·멈춤). In a shell
//    pane a report from a program that died without clearing it would stay,
//    because the spec drops it at the next shell prompt (OSC 133) and oort
//    reads no prompts.
// 2. **Framing.** `ESC ] 7501 ;` up to BEL or ST (`ESC \`), across any number
//    of reads. CAN, SUB or any other ESC ends the sequence unread, as in a VT
//    parser. 8-bit C1 introducers are not recognised.
// 3. **Size.** At most `MAX_SEQUENCE` bytes, introducer to terminator (the
//    spec's own limit). A longer sequence is skipped to its end and dropped
//    whole. 4096, not less: Claude Code's reports carry a base64 `msg` of up
//    to 2,732 bytes.
// 4. **Which record.** Only the root record (no `id`) is the pane's status.
//    A record with an `id` is a sub-task of the program (Claude Code reports
//    background tasks that way) and is ignored, `state=clear:id=…` included.
//    `state=clear` without an id withdraws the program's report.
// 5. **Whose record.** `app`, when present, must name the pane's harness
//    (`app_names`: its own id, and `claude-code` for `claude`). A report from
//    any other program (one the harness ran in its terminal, say) is ignored.
//    No `app` reads as the harness's own (ADR-0190 증보: `app`은 하네스 라벨과
//    대조만 한다).
// 6. **Meaning.** `signal_for` maps `state` and `kind` onto `PaneSignal`. A
//    pair without `=` or with a byte outside the spec's grammar is skipped.
//    An unknown or missing `state` drops the report; an unknown `kind`, or a
//    `kind` on any state but `blocked`, reads as absent. Repeated key: the
//    last one wins.
// 7. **The query.** A payload of exactly `?` (the spec's whole query) is
//    `Seen::Query`, once per sequence. Anything else that starts with `?` (a
//    terminal's reply, our own echoed back, `??`, `? `) is neither a query
//    nor a report. The closed list of queries answered is this one.
//
// Lifetime (the spec clears `working`/`blocked`/`idle` at a new shell prompt,
// which oort cannot see): a new report or `state=clear` replaces the current
// one; process exit hands the pane to its lifecycle; `done`/`error` stay
// until the program replaces them (Codex does on the person's key, paste or
// click). Which source wins when hooks and reports overlap is decided in
// `@momo/core/features/workbench/paneStatus`.

use crate::pane_signal::PaneSignal;

/// The whole sequence, introducer to terminator (spec revision 0.4).
pub const MAX_SEQUENCE: usize = 4096;

/// The terminal's whole answer to `OSC 7501 ; ?` (spec revision 0.4, Feature
/// detection: "A supporting terminal MUST reply with `?`"). Fixed bytes: the
/// spec's own example without its notation spaces, naming the states and
/// kinds `parse` reads. It ends with BEL, which the spec's conventions count
/// as ST and which Claude Code's own query uses. "The only bytes a terminal
/// writes back are the feature detection reply, which contains nothing from
/// any report": nothing from the program's output goes into it.
pub const REPLY: &[u8] =
    b"\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x07";

/// The one query answered: the payload of `OSC 7501 ; ? ST`, exactly.
const QUERY: &[u8] = b"?";
const INTRODUCER: &[u8] = b"\x1b]7501;";
const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;
/// The longest payload that still fits with the shorter terminator (BEL).
const MAX_PAYLOAD: usize = MAX_SEQUENCE - INTRODUCER.len() - 1;

/// `state` (spec revision 0.4). `Clear` is not a state: it removes the record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Idle,
    Working,
    Blocked,
    Done,
    Error,
    Clear,
}

/// `kind`, meaningful with `blocked` only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Permission,
    Question,
    Auth,
}

/// One root-record report, reduced to its two closed words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Report {
    pub state: State,
    pub kind: Option<Kind>,
}

/// One finished 7501 sequence that means something to the pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seen {
    /// The pane harness's status report.
    Report(Report),
    /// The program asked `OSC 7501 ; ?`: the pane answers `REPLY`, once.
    Query,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Mode {
    /// Outside any 7501 sequence.
    #[default]
    Ground,
    /// Matched the first `n` bytes of `INTRODUCER` (at least the ESC).
    Introducer(usize),
    /// Inside the payload.
    Payload,
    /// ESC inside the payload: `\` ends it (ST), anything else aborts it.
    PayloadEsc,
    /// Past `MAX_PAYLOAD`: keep nothing until the sequence ends, then drop it.
    Skip,
    SkipEsc,
}

/// One pane's scanner. Holds at most one unfinished sequence between reads.
#[derive(Debug)]
pub struct Scanner {
    mode: Mode,
    payload: Vec<u8>,
    /// The pane's harness id (one of `pty::HARNESSES`), for the `app` check.
    harness: Vec<u8>,
}

impl Scanner {
    /// The scanner for a pane that runs `harness` (its id, as bytes).
    pub fn for_harness(harness: &[u8]) -> Self {
        Self {
            mode: Mode::default(),
            payload: Vec::new(),
            harness: harness.to_vec(),
        }
    }

    /// The reports and queries completed in `bytes`, in order. The bytes
    /// themselves are not kept past the sequence they belong to.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Seen> {
        let mut seen = Vec::new();
        for &b in bytes {
            if let Some(one) = self.step(b) {
                seen.push(one);
            }
        }
        seen
    }

    fn step(&mut self, b: u8) -> Option<Seen> {
        match self.mode {
            Mode::Ground => {
                if b == ESC {
                    self.mode = Mode::Introducer(1);
                }
            }
            Mode::Introducer(n) => {
                if b == INTRODUCER[n] {
                    if n + 1 == INTRODUCER.len() {
                        self.payload.clear();
                        self.mode = Mode::Payload;
                    } else {
                        self.mode = Mode::Introducer(n + 1);
                    }
                } else {
                    // Another escape sequence (or a fresh ESC): not ours.
                    self.mode = if b == ESC {
                        Mode::Introducer(1)
                    } else {
                        Mode::Ground
                    };
                }
            }
            Mode::Payload => match b {
                BEL => return self.finish(1),
                ESC => self.mode = Mode::PayloadEsc,
                CAN | SUB => self.abort(),
                _ if self.payload.len() < MAX_PAYLOAD => self.payload.push(b),
                _ => {
                    self.payload.clear();
                    self.mode = Mode::Skip;
                }
            },
            Mode::PayloadEsc => {
                if b == b'\\' {
                    return self.finish(2);
                }
                // The ESC starts something else; this sequence ends unread.
                self.abort();
                return self.after_esc(b);
            }
            Mode::Skip => match b {
                BEL | CAN | SUB => self.abort(),
                ESC => self.mode = Mode::SkipEsc,
                _ => {}
            },
            Mode::SkipEsc => {
                self.abort();
                if b != b'\\' {
                    return self.after_esc(b);
                }
            }
        }
        None
    }

    /// `b` follows an ESC that ended a sequence: read it as an introducer byte.
    fn after_esc(&mut self, b: u8) -> Option<Seen> {
        self.mode = Mode::Introducer(1);
        self.step(b)
    }

    fn abort(&mut self) {
        self.payload.clear();
        self.mode = Mode::Ground;
    }

    fn finish(&mut self, terminator: usize) -> Option<Seen> {
        let fits = INTRODUCER.len() + self.payload.len() + terminator <= MAX_SEQUENCE;
        let seen = if !fits {
            None
        } else if self.payload == QUERY {
            Some(Seen::Query)
        } else {
            parse(&self.payload, &self.harness).map(Seen::Report)
        };
        self.abort();
        seen
    }
}

/// A byte of a value: `[A-Za-z0-9_.,+/=-]` (spec revision 0.4).
fn value_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b',' | b'+' | b'/' | b'=' | b'-')
}

/// Does `app` name this harness? Its own id, or the name its CLI writes.
fn app_names(harness: &[u8], app: &[u8]) -> bool {
    app == harness || matches!((harness, app), (b"claude", b"claude-code"))
}

/// One payload (`key=value(:key=value)*`) → the harness's root-record
/// report, if any.
fn parse(payload: &[u8], harness: &[u8]) -> Option<Report> {
    let mut state = None;
    let mut kind = None;
    let mut app = None;
    let mut child = false;
    for pair in payload.split(|&b| b == b':') {
        let Some(eq) = pair.iter().position(|&b| b == b'=') else {
            continue;
        };
        let (key, value) = (&pair[..eq], &pair[eq + 1..]);
        if key.is_empty()
            || !key.iter().all(u8::is_ascii_lowercase)
            || !value.iter().copied().all(value_byte)
        {
            continue;
        }
        match key {
            b"state" => state = Some(value),
            b"kind" => kind = Some(value),
            b"app" => app = Some(value),
            b"id" => child = true,
            _ => {}
        }
    }
    if child || app.is_some_and(|app| !app_names(harness, app)) {
        return None;
    }
    let state = match state? {
        b"idle" => State::Idle,
        b"working" => State::Working,
        b"blocked" => State::Blocked,
        b"done" => State::Done,
        b"error" => State::Error,
        b"clear" => State::Clear,
        _ => return None,
    };
    let kind = match (state, kind) {
        (State::Blocked, Some(b"permission")) => Some(Kind::Permission),
        (State::Blocked, Some(b"question")) => Some(Kind::Question),
        (State::Blocked, Some(b"auth")) => Some(Kind::Auth),
        _ => None,
    };
    Some(Report { state, kind })
}

/// The pane signal a report sets, or `None` when the program withdrew its
/// report (`state=clear`). The whole mapping:
///
/// | OSC 7501 | `PaneSignal` | 칸 |
/// |---|---|---|
/// | `idle` | `Ready` | 대기 |
/// | `working` | `Working` | 실행 중 |
/// | `blocked` + `kind=permission` | `WaitingPermission` | 응답 필요 · 실행 허락 |
/// | `blocked` + `question`·`auth`·none | `WaitingInput` | 응답 필요 · 답 |
/// | `done` | `TurnDone` | 끝남 |
/// | `error` | `TurnFailed` | 실패 · 오류로 끝났어요 |
/// | `clear` | none | 생명주기 |
///
/// `error` is its own signal (design-review #5584 H1): the program said the
/// turn failed, so the pane must not say 끝남 with a check. It keeps `done`'s
/// lifetime (the spec keeps it until the person has seen it; the program is
/// alive at its prompt), so the webview files it under 끝남 for ordering and
/// notification and draws it as 실패. 멈춤 would be wrong: that is the pane's
/// *process* stopping (`statusFromPhase`), which it has not.
pub fn signal_for(report: Report) -> Option<PaneSignal> {
    match report.state {
        State::Idle => Some(PaneSignal::Ready),
        State::Working => Some(PaneSignal::Working),
        State::Blocked => Some(match report.kind {
            Some(Kind::Permission) => PaneSignal::WaitingPermission,
            Some(Kind::Question | Kind::Auth) | None => PaneSignal::WaitingInput,
        }),
        State::Done => Some(PaneSignal::TurnDone),
        State::Error => Some(PaneSignal::TurnFailed),
        State::Clear => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Codex pane: most fixtures are Codex's bytes, or carry no `app`.
    fn scan(bytes: &[u8]) -> Vec<Report> {
        scan_in(b"codex", bytes)
    }

    /// The reports in `bytes`, queries left out (they have their own tests).
    fn scan_in(harness: &[u8], bytes: &[u8]) -> Vec<Report> {
        Scanner::for_harness(harness)
            .feed(bytes)
            .into_iter()
            .filter_map(|seen| match seen {
                Seen::Report(report) => Some(report),
                Seen::Query => None,
            })
            .collect()
    }

    /// Everything a Claude pane's scanner makes of `bytes`.
    fn seen(bytes: &[u8]) -> Vec<Seen> {
        Scanner::for_harness(b"claude").feed(bytes)
    }

    fn signals(bytes: &[u8]) -> Vec<Option<PaneSignal>> {
        signals_in(b"codex", bytes)
    }

    fn signals_in(harness: &[u8], bytes: &[u8]) -> Vec<Option<PaneSignal>> {
        scan_in(harness, bytes)
            .into_iter()
            .map(signal_for)
            .collect()
    }

    const fn report(state: State, kind: Option<Kind>) -> Report {
        Report { state, kind }
    }

    /// Codex 0.165's exact bytes (`SetTerminalProgramStatus`, ST-terminated).
    const CODEX_BLOCKED: &[u8] = b"\x1b]7501;state=blocked:app=codex:kind=permission\x1b\\";

    #[test]
    fn codex_and_claude_reports_map_to_the_closed_table() {
        use PaneSignal::*;
        let (codex, claude): (&'static [u8], &'static [u8]) = (b"codex", b"claude");
        let cases: &[(&'static [u8], &[u8], Option<PaneSignal>)] = &[
            (codex, b"\x1b]7501;state=idle:app=codex\x1b\\", Some(Ready)),
            (
                codex,
                b"\x1b]7501;state=working:app=codex\x1b\\",
                Some(Working),
            ),
            (codex, CODEX_BLOCKED, Some(WaitingPermission)),
            (
                codex,
                b"\x1b]7501;state=blocked:app=codex:kind=question\x1b\\",
                Some(WaitingInput),
            ),
            (
                codex,
                b"\x1b]7501;state=blocked:app=codex:kind=auth\x1b\\",
                Some(WaitingInput),
            ),
            (
                codex,
                b"\x1b]7501;state=done:app=codex\x1b\\",
                Some(TurnDone),
            ),
            // A failed turn is not a finished one (design-review #5584 H1).
            (
                codex,
                b"\x1b]7501;state=error:app=codex\x1b\\",
                Some(TurnFailed),
            ),
            (codex, b"\x1b]7501;state=clear\x1b\\", None),
            // Claude Code 2.1.312 (`P1r`): BEL, `app=claude-code`, base64 msg.
            (
                claude,
                b"\x1b]7501;state=blocked:app=claude-code:kind=permission:msg=QWxsb3cgQmFzaD8=\x07",
                Some(WaitingPermission),
            ),
            // `dialog open`: blocked with no kind.
            (
                claude,
                b"\x1b]7501;state=blocked:app=claude-code\x07",
                Some(WaitingInput),
            ),
            (
                claude,
                b"\x1b]7501;state=working:app=claude-code:progress=40\x07",
                Some(Working),
            ),
            (
                claude,
                b"\x1b]7501;state=error:app=claude-code\x07",
                Some(TurnFailed),
            ),
        ];
        for (harness, bytes, want) in cases {
            assert_eq!(
                signals_in(harness, bytes),
                [*want],
                "{:?}",
                String::from_utf8_lossy(bytes)
            );
        }
        // Nothing reads an error as a finished turn.
        for harness in [codex, claude] {
            assert_ne!(
                signals_in(harness, b"\x1b]7501;state=error\x07"),
                [Some(TurnDone)]
            );
        }
    }

    /// ADR-0190 증보 「`app`은 하네스 라벨과 대조만 한다」 (design-review #5584 M1):
    /// a report names its program; a pane takes only its own harness's.
    #[test]
    fn a_report_counts_only_when_app_names_the_pane_harness() {
        use PaneSignal::*;
        let blocked = |app: &str| format!("\x1b]7501;state=blocked:kind=permission{app}\x1b\\");
        let own: [(&'static [u8], &str); 6] = [
            (b"codex", ":app=codex"),
            (b"codex", ""),
            (b"claude", ":app=claude-code"),
            (b"claude", ":app=claude"),
            (b"claude", ""),
            (b"grok", ":app=grok"),
        ];
        for (harness, app) in own {
            assert_eq!(
                signals_in(harness, blocked(app).as_bytes()),
                [Some(WaitingPermission)],
                "{} pane, {app:?}",
                String::from_utf8_lossy(harness)
            );
        }
        let foreign: [(&'static [u8], &str); 8] = [
            (b"codex", ":app=claude-code"),
            (b"codex", ":app=Codex"),
            (b"codex", ":app=codex-cli"),
            (b"codex", ":app="),
            (b"claude", ":app=codex"),
            (b"claude", ":app=claude-code-x"),
            (b"grok", ":app=codex"),
            (b"grok", ":app=claude-code"),
        ];
        for (harness, app) in foreign {
            assert!(
                scan_in(harness, blocked(app).as_bytes()).is_empty(),
                "{} pane took {app:?}",
                String::from_utf8_lossy(harness)
            );
        }
        // The last `app` wins, like any repeated key; a foreign one in the
        // middle of a stream changes nothing and the next own report reads.
        assert!(scan(b"\x1b]7501;app=codex:state=done:app=other\x07").is_empty());
        assert_eq!(
            signals(
                b"\x1b]7501;state=working:app=claude-code\x07\x1b]7501;state=done:app=codex\x07"
            ),
            [Some(TurnDone)]
        );
    }

    #[test]
    fn a_sequence_split_at_every_byte_still_reads_once() {
        for terminator in [&b"\x07"[..], &b"\x1b\\"[..]] {
            let mut whole = b"plain \x1b[1mtext\x1b[0m ".to_vec();
            whole.extend_from_slice(b"\x1b]7501;state=blocked:app=codex:kind=permission");
            whole.extend_from_slice(terminator);
            whole.extend_from_slice(b" more");
            for cut in 0..=whole.len() {
                let mut scanner = Scanner::for_harness(b"codex");
                let mut got = scanner.feed(&whole[..cut]);
                got.extend(scanner.feed(&whole[cut..]));
                assert_eq!(
                    got,
                    [Seen::Report(report(State::Blocked, Some(Kind::Permission)))],
                    "cut at {cut} of {:?}",
                    String::from_utf8_lossy(&whole)
                );
            }
            // One byte per read.
            let mut scanner = Scanner::for_harness(b"codex");
            let got: Vec<Seen> = whole.iter().flat_map(|b| scanner.feed(&[*b])).collect();
            assert_eq!(got.len(), 1);
        }
    }

    #[test]
    fn junk_other_escapes_and_aborts_read_nothing() {
        for junk in [
            &b"state=blocked:kind=permission"[..],
            b"\x1b]0;state=blocked\x07",
            b"\x1b]2;\x1b]7501\x07",
            b"\x1b]133;A\x07",
            b"\x1b]8;;https://example.test/state=blocked\x1b\\",
            b"\x1b]75010;state=blocked\x07",
            b"\x1b]07501;state=blocked\x07",
            b"\x1b]7500;state=blocked\x07",
            b"\x1b]1337;state=blocked\x07",
            b"\x1b]7501state=blocked\x07",
            b"\x1b[7501;state=blocked\x07",
            b"\x1b]7501;state=blocked\x18",
            b"\x1b]7501;state=blocked\x1a",
            b"\xc2\x9d7501;state=blocked\x07",
            b"\x1b]7501;state=blocked\xc2\x9c",
            b"\x00\xff\x1b\x1b\x1b]\x1b]7\x1b]75\x07\x1b\\",
        ] {
            assert!(scan(junk).is_empty(), "{:?}", String::from_utf8_lossy(junk));
        }
        // An ESC inside the payload ends it unread and may start a real one.
        assert_eq!(
            scan(b"\x1b]7501;state=working\x1b\x1b]7501;state=done\x07"),
            [report(State::Done, None)]
        );
        assert_eq!(
            scan(b"\x1b]7501;state=working\x1b[0m\x1b]7501;state=idle\x1b\\"),
            [report(State::Idle, None)]
        );
        // The query and a terminal's reply carry no state.
        assert!(scan(b"\x1b]7501;?\x1b\\").is_empty());
        assert!(scan(b"\x1b]7501;?:states=idle,working:kinds=permission\x1b\\").is_empty());
    }

    #[test]
    fn an_overlong_sequence_is_dropped_whole_and_the_next_one_reads() {
        let head = b"\x1b]7501;state=blocked:kind=permission:msg=";
        let fill = |total: usize, terminator: &[u8]| {
            let mut v = head.to_vec();
            v.resize(total - terminator.len(), b'A');
            v.extend_from_slice(terminator);
            v
        };
        // Exactly the limit reads, with either terminator.
        for terminator in [&b"\x07"[..], &b"\x1b\\"[..]] {
            let at_limit = fill(MAX_SEQUENCE, terminator);
            assert_eq!(at_limit.len(), MAX_SEQUENCE);
            assert_eq!(
                scan(&at_limit),
                [report(State::Blocked, Some(Kind::Permission))]
            );
            let over = fill(MAX_SEQUENCE + 1, terminator);
            assert!(scan(&over).is_empty(), "{} bytes", over.len());
        }
        // Far past the limit, then a good one: the skip ends at the terminator.
        let mut huge = head.to_vec();
        huge.resize(100_000, b'A');
        huge.extend_from_slice(b"\x07\x1b]7501;state=working\x1b\\");
        let mut scanner = Scanner::for_harness(b"codex");
        let got: Vec<Seen> = huge.chunks(4096).flat_map(|c| scanner.feed(c)).collect();
        assert_eq!(got, [Seen::Report(report(State::Working, None))]);
        assert!(scanner.payload.capacity() <= MAX_SEQUENCE, "kept the skip");
        // An ESC aborts a skip too, and may start a real sequence.
        let mut aborted = head.to_vec();
        aborted.resize(MAX_SEQUENCE + 10, b'A');
        aborted.extend_from_slice(b"\x1b]7501;state=idle\x07");
        assert_eq!(scan(&aborted), [report(State::Idle, None)]);
    }

    #[test]
    fn only_the_root_record_with_a_known_state_is_a_report() {
        for ignored in [
            // A sub-task record (Claude Code background tasks), and its clear.
            &b"\x1b]7501;state=working:app=claude-code:id=bg_1:title=eA==\x07"[..],
            b"\x1b]7501;state=clear:id=bg_1\x07",
            b"\x1b]7501;id=a/b:state=blocked:kind=permission\x07",
            b"\x1b]7501;state=paused:app=codex\x1b\\",
            b"\x1b]7501;state=Working\x1b\\",
            b"\x1b]7501;app=codex\x1b\\",
            b"\x1b]7501;\x1b\\",
            // `state` whose value breaks the grammar is a malformed pair.
            b"\x1b]7501;state=blocked;x\x07",
            b"\x1b]7501;state=bl ocked\x07",
        ] {
            assert!(
                scan(ignored).is_empty(),
                "{:?}",
                String::from_utf8_lossy(ignored)
            );
        }
        // Malformed pairs are skipped, the rest is read; unknown keys ignored;
        // the last of a repeated key wins.
        assert_eq!(
            scan(b"\x1b]7501;junk:=x:Kind=question:\xff=1:state=working:extra=1:state=blocked:kind=question\x07"),
            [report(State::Blocked, Some(Kind::Question))]
        );
        // An unknown kind, or a kind on a state but blocked, reads as absent.
        assert_eq!(
            scan(b"\x1b]7501;state=blocked:kind=payment\x07"),
            [report(State::Blocked, None)]
        );
        assert_eq!(
            scan(b"\x1b]7501;state=done:kind=permission\x07"),
            [report(State::Done, None)]
        );
        assert_eq!(
            signals(b"\x1b]7501;state=blocked:kind=payment\x07"),
            [Some(PaneSignal::WaitingInput)]
        );
    }

    #[test]
    fn every_report_in_a_read_comes_out_in_order() {
        use PaneSignal::*;
        let bytes = b"\x1b]7501;state=working\x1b\\out\x1b]7501;state=blocked:kind=permission\x1b\\\r\n\x1b]7501;state=working\x07\x1b]7501;state=done\x07\x1b]7501;state=clear\x1b\\";
        assert_eq!(
            signals(bytes),
            [
                Some(Working),
                Some(WaitingPermission),
                Some(Working),
                Some(TurnDone),
                None
            ]
        );
    }

    /// #5586: the feature-detection query, and only it, is a query. Once per
    /// sequence, with either terminator, across any split; anything else
    /// starting with `?` is nothing, our own reply included, so a reply
    /// echoed back by a cooked tty cannot ask again.
    #[test]
    fn the_query_is_seen_once_per_sequence_and_nothing_else_is_one() {
        // Claude Code 2.1.312's probe: BEL, then DA1 as its sentinel.
        assert_eq!(seen(b"\x1b]7501;?\x07\x1b[c"), [Seen::Query]);
        // The spec's form: ST.
        assert_eq!(seen(b"\x1b]7501;?\x1b\\"), [Seen::Query]);
        // Two queries, two; reports in between keep their place.
        assert_eq!(
            seen(b"\x1b]7501;?\x07\x1b]7501;state=working:app=claude-code\x07\x1b]7501;?\x1b\\"),
            [
                Seen::Query,
                Seen::Report(report(State::Working, None)),
                Seen::Query
            ]
        );
        let whole = b"text \x1b[1m\x1b]7501;?\x07 more";
        for cut in 0..=whole.len() {
            let mut scanner = Scanner::for_harness(b"claude");
            let mut got = scanner.feed(&whole[..cut]);
            got.extend(scanner.feed(&whole[cut..]));
            assert_eq!(got, [Seen::Query], "cut at {cut}");
        }
        let mut scanner = Scanner::for_harness(b"claude");
        let one_by_one: Vec<Seen> = whole.iter().flat_map(|b| scanner.feed(&[*b])).collect();
        assert_eq!(one_by_one, [Seen::Query]);
        for not_query in [
            &b"\x1b]7501;??\x07"[..],
            b"\x1b]7501;?x\x07",
            b"\x1b]7501;? \x07",
            b"\x1b]7501; ?\x07",
            b"\x1b]7501;?:\x07",
            b"\x1b]7501;?:rev=1\x07",
            b"\x1b]7501;?:states=idle,working:kinds=permission\x1b\\",
            REPLY,
            b"\x1b]7501;\x07",
            b"\x1b]7501?\x07",
            b"\x1b]7500;?\x07",
            b"\x1b]75010;?\x07",
            b"\x1b]07501;?\x07",
            b"\x1b]10;?\x07",
            b"\x1b[7501;?\x07",
            b"\x1b]7501;?\x18",
            b"\x1b]7501;?\x1a",
            b"\x1b]7501;?\x1b[c",
            b"\xc2\x9d7501;?\x07",
            b"\x1b]7501;?\xc2\x9c",
            b"?\x07",
            // Unterminated: nothing until it ends.
            b"\x1b]7501;?",
        ] {
            assert!(
                seen(not_query).is_empty(),
                "{:?}",
                String::from_utf8_lossy(not_query)
            );
        }
        // An over-long sequence that starts like the query is dropped whole.
        let mut long = b"\x1b]7501;?".to_vec();
        long.resize(MAX_SEQUENCE + 1, b'?');
        long.push(0x07);
        assert!(seen(&long).is_empty());
    }

    /// The reply is the spec's fixed answer: it starts with `?` (what Claude
    /// Code checks, `data.startsWith("?")`), it fits, and the states and kinds
    /// it lists are exactly the ones this module reads.
    #[test]
    fn the_reply_is_fixed_and_names_what_this_module_reads() {
        assert_eq!(
            REPLY,
            b"\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x07"
        );
        assert!(REPLY.len() <= MAX_SEQUENCE);
        let body = REPLY
            .strip_prefix(INTRODUCER)
            .and_then(|b| b.strip_suffix(&[BEL]))
            .expect("framed as OSC 7501 … BEL");
        let mut pairs = body.split(|&b| b == b':');
        assert_eq!(pairs.next(), Some(QUERY));
        let states = pairs.next().and_then(|p| p.strip_prefix(b"states="));
        let kinds = pairs.next().and_then(|p| p.strip_prefix(b"kinds="));
        assert!(pairs.next().is_none());
        let states: Vec<&[u8]> = states.expect("states").split(|&b| b == b',').collect();
        let kinds: Vec<&[u8]> = kinds.expect("kinds").split(|&b| b == b',').collect();
        assert_eq!(states.len(), 5, "every state but clear");
        for state in &states {
            let mut bytes = b"\x1b]7501;state=".to_vec();
            bytes.extend_from_slice(state);
            bytes.push(BEL);
            let read = scan(&bytes);
            assert_eq!(read.len(), 1, "{:?}", String::from_utf8_lossy(state));
            assert_ne!(read[0].state, State::Clear);
        }
        assert_eq!(kinds.len(), 3);
        for kind in &kinds {
            let mut bytes = b"\x1b]7501;state=blocked:kind=".to_vec();
            bytes.extend_from_slice(kind);
            bytes.push(BEL);
            assert!(
                matches!(scan(&bytes)[..], [Report { kind: Some(_), .. }]),
                "{:?}",
                String::from_utf8_lossy(kind)
            );
        }
    }
}
