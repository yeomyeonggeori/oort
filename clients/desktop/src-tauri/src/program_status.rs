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
// Code writes it too, but only to a terminal that answers its `OSC 7501 ; ?`
// probe, which oort does not (see the #5579 PR body).
//
// Every other byte (text, titles, other OSCs, CSI) passes by without being
// kept or forwarded. Of a 7501 report this module reads `state`, `kind` and
// whether an `id` is present: words from closed lists. `title` and `msg` are
// base64 text and are skipped unread, like any other key. What leaves is a
// `Report` of two enums. `shell_contract.rs` pins all of this by source.
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
// 5. **Meaning.** `signal_for` maps `state` and `kind` onto `PaneSignal`. A
//    pair without `=` or with a byte outside the spec's grammar is skipped.
//    An unknown or missing `state` drops the report; an unknown `kind`, or a
//    `kind` on any state but `blocked`, reads as absent. Repeated key: the
//    last one wins.
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
#[derive(Debug, Default)]
pub struct Scanner {
    mode: Mode,
    payload: Vec<u8>,
}

impl Scanner {
    /// The reports completed in `bytes`, in order. The bytes themselves are
    /// not kept past the sequence they belong to.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Report> {
        let mut reports = Vec::new();
        for &b in bytes {
            if let Some(report) = self.step(b) {
                reports.push(report);
            }
        }
        reports
    }

    fn step(&mut self, b: u8) -> Option<Report> {
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
    fn after_esc(&mut self, b: u8) -> Option<Report> {
        self.mode = Mode::Introducer(1);
        self.step(b)
    }

    fn abort(&mut self) {
        self.payload.clear();
        self.mode = Mode::Ground;
    }

    fn finish(&mut self, terminator: usize) -> Option<Report> {
        let fits = INTRODUCER.len() + self.payload.len() + terminator <= MAX_SEQUENCE;
        let report = if fits { parse(&self.payload) } else { None };
        self.abort();
        report
    }
}

/// A byte of a value: `[A-Za-z0-9_.,+/=-]` (spec revision 0.4).
fn value_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b',' | b'+' | b'/' | b'=' | b'-')
}

/// One payload (`key=value(:key=value)*`) → its root-record report, if any.
fn parse(payload: &[u8]) -> Option<Report> {
    let mut state = None;
    let mut kind = None;
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
            b"id" => child = true,
            _ => {}
        }
    }
    if child {
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
/// | `error` | `TurnDone` | 끝남 |
/// | `clear` | none | 생명주기 |
///
/// `error` reads as 끝남: the spec gives it `done`'s lifetime (kept until the
/// person has seen it), the program is alive at its prompt waiting for the
/// person exactly as after `done`, and 멈춤 means the pane's *process* stopped
/// (`statusFromPhase`), which it has not. Telling a failed turn apart is a
/// design-review question, not a new word here.
pub fn signal_for(report: Report) -> Option<PaneSignal> {
    match report.state {
        State::Idle => Some(PaneSignal::Ready),
        State::Working => Some(PaneSignal::Working),
        State::Blocked => Some(match report.kind {
            Some(Kind::Permission) => PaneSignal::WaitingPermission,
            Some(Kind::Question | Kind::Auth) | None => PaneSignal::WaitingInput,
        }),
        State::Done | State::Error => Some(PaneSignal::TurnDone),
        State::Clear => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(bytes: &[u8]) -> Vec<Report> {
        Scanner::default().feed(bytes)
    }

    fn signals(bytes: &[u8]) -> Vec<Option<PaneSignal>> {
        scan(bytes).into_iter().map(signal_for).collect()
    }

    const fn report(state: State, kind: Option<Kind>) -> Report {
        Report { state, kind }
    }

    /// Codex 0.165's exact bytes (`SetTerminalProgramStatus`, ST-terminated).
    const CODEX_BLOCKED: &[u8] = b"\x1b]7501;state=blocked:app=codex:kind=permission\x1b\\";

    #[test]
    fn codex_and_claude_reports_map_to_the_closed_table() {
        use PaneSignal::*;
        let cases: &[(&[u8], Option<PaneSignal>)] = &[
            (b"\x1b]7501;state=idle:app=codex\x1b\\", Some(Ready)),
            (b"\x1b]7501;state=working:app=codex\x1b\\", Some(Working)),
            (CODEX_BLOCKED, Some(WaitingPermission)),
            (
                b"\x1b]7501;state=blocked:app=codex:kind=question\x1b\\",
                Some(WaitingInput),
            ),
            (
                b"\x1b]7501;state=blocked:app=codex:kind=auth\x1b\\",
                Some(WaitingInput),
            ),
            (b"\x1b]7501;state=done:app=codex\x1b\\", Some(TurnDone)),
            (b"\x1b]7501;state=error:app=codex\x1b\\", Some(TurnDone)),
            (b"\x1b]7501;state=clear\x1b\\", None),
            // Claude Code 2.1.312 (`P1r`): BEL, `app=claude-code`, base64 msg.
            (
                b"\x1b]7501;state=blocked:app=claude-code:kind=permission:msg=QWxsb3cgQmFzaD8=\x07",
                Some(WaitingPermission),
            ),
            // `dialog open`: blocked with no kind.
            (
                b"\x1b]7501;state=blocked:app=claude-code\x07",
                Some(WaitingInput),
            ),
            (
                b"\x1b]7501;state=working:app=claude-code:progress=40\x07",
                Some(Working),
            ),
        ];
        for (bytes, want) in cases {
            assert_eq!(
                signals(bytes),
                [*want],
                "{:?}",
                String::from_utf8_lossy(bytes)
            );
        }
    }

    #[test]
    fn a_sequence_split_at_every_byte_still_reads_once() {
        for terminator in [&b"\x07"[..], &b"\x1b\\"[..]] {
            let mut whole = b"plain \x1b[1mtext\x1b[0m ".to_vec();
            whole.extend_from_slice(b"\x1b]7501;state=blocked:app=codex:kind=permission");
            whole.extend_from_slice(terminator);
            whole.extend_from_slice(b" more");
            for cut in 0..=whole.len() {
                let mut scanner = Scanner::default();
                let mut got = scanner.feed(&whole[..cut]);
                got.extend(scanner.feed(&whole[cut..]));
                assert_eq!(
                    got,
                    [report(State::Blocked, Some(Kind::Permission))],
                    "cut at {cut} of {:?}",
                    String::from_utf8_lossy(&whole)
                );
            }
            // One byte per read.
            let mut scanner = Scanner::default();
            let got: Vec<Report> = whole.iter().flat_map(|b| scanner.feed(&[*b])).collect();
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
        let mut scanner = Scanner::default();
        let got: Vec<Report> = huge.chunks(4096).flat_map(|c| scanner.feed(c)).collect();
        assert_eq!(got, [report(State::Working, None)]);
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
}
