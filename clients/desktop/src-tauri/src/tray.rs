// The menu-bar icon and its menu (#5193, ADR-0133 B-group). macOS only: the other desktops get no
// tray in this stage, and `tray_status_set` answers `Ok(())` there after the same validation.
//
// Built in Rust, never by the page. The page's whole part is ONE narrow command, `tray_status_set`:
// it sends the state of the moment (the Dock badge's number, the running work, the menu's words
// already in the person's language) and the shell draws it. The way back is the existing event
// bridge: a menu entry that needs the page emits `momo:tray-action` (`TrayAction`), the same global
// emit `momo:notification-click` uses. No tray permission is opened to the webview: tauri's own JS
// tray API (`plugin:tray|*`) rides in on `core:default` the moment the `tray-icon` feature is on, so
// `capabilities/default.json` denies each of those commands and `shell_contract.rs` measures that
// the page cannot call them.
//
// What is and is not trusted:
//   * Everything in `TrayStatus` comes from the page and is checked here: how many rows, how long a
//     label, which characters. A bad status is an error and the menu keeps what it had.
//   * A row's `id` is the page's own token for one running job. The shell only checks its SHAPE
//     (`[A-Za-z0-9_-]`, <= 64 bytes) because the id becomes part of a menu id and comes back in the
//     event. Whether it is a job the page really listed is the page's call: it matches the id
//     against its own last rows and ignores everything else (`features/notifications/TrayStatus.tsx`,
//     rows built by `trayModel.ts`).
//   * Titles are the page's data (an agent's or a session's name). They are cleaned (control and
//     bidi characters, runs of blanks) and cut at `MAX_TITLE_CHARS`, so one odd name cannot widen the
//     menu or reorder its text.
//
// The icon is a macOS TEMPLATE image: only its alpha counts and AppKit tints it for a light or a dark
// menu bar. Two bitmaps, the mark and the mark with a dot (`icons/tray/`, made from the brand mark by
// `scripts/desktop/render_tray_icons.sh`). tray-icon takes one bitmap and fixes the image height to
// 18pt, so the @2x (36x36) files are the ones embedded. The dot means "the Dock badge would show a
// number": the page sends the very number it gives `dock_badge_set`, and this module only reads
// `> 0`.
//
// Quit is macOS's own Quit item (`PredefinedMenuItem::quit`, AppKit `terminate:`) — the item the
// app menu's Cmd+Q is. So the tray quits exactly the way Cmd+Q does, with the same scope
// (`rotation_hold.rs` says what that path does and does not wait for), instead of a second exit
// path of our own.
//
// Since #5196 the menu is also what keeps the app reachable once the red button has put the window
// away (`main_window.rs`): 「oort 열기」 brings it back, 「oort 종료」 ends the app. That is why this
// state also answers one question for the close decision — `TrayState::keeps_app_running`: the icon is
// up AND the page's app shell is up (someone is signed in). With no one signed in there is nothing to
// keep running for, and the red button ends the app as it always did.
//
// 「모두 읽음 처리」 (#5195) is a pick the PAGE carries out (it holds the read state and the session);
// it is done where the person is, so unlike every other pick it does not bring the window forward. The
// line under it says what it leaves: approvals and answers still waiting close only by a decision, so
// the dot may stay after the pick, and that line (already in the person's language, like every word
// here) is the reason.
//
// `runtime-unverified`: the status item itself, the template rendering on light and dark bars, the
// menu on screen and the quit click need a real Mac. The tests below measure everything that does
// not: the menu model, the input limits, the menu ids, the event payload and the two bitmaps.

// Off macOS only the validation half is reachable, which leaves the model's fields unread.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Runtime};

use crate::main_window;

/// Emitted when the person picks a menu entry that needs the page. Kept under the old `momo:`
/// prefix like every other event channel, so the page's listener name never has to change.
pub const TRAY_ACTION_EVENT: &str = "momo:tray-action";

/// How many running jobs the menu lists. The page sends at most this many (it pins the same
/// number against `tests/fixtures/tray_limits.json`, `trayModel.test.ts`) and says how many more there are in `more`.
pub const MAX_RUN_ROWS: usize = 6;

/// How many characters of a job's name the menu shows. Longer names end in an ellipsis; the state
/// that follows the name is never cut.
pub const MAX_TITLE_CHARS: usize = 24;

/// The longest label the page may send (a menu word, a state word, the overflow line).
const MAX_LABEL_BYTES: usize = 256;

/// The longest raw title the page may send. A name is cut for display at `MAX_TITLE_CHARS`; this
/// bound only refuses input no real name reaches.
const MAX_RAW_TITLE_BYTES: usize = 1024;

/// The longest row id, in bytes.
const MAX_ID_BYTES: usize = 64;

const ID_OPEN: &str = "tray.open";
const ID_NEW_MESSAGE: &str = "tray.new-message";
const ID_READ_ALL: &str = "tray.read-all";
const ID_RUN_PREFIX: &str = "tray.run.";

// ---- what the page sends -----------------------------------------------------------------------

/// The menu's words, already formatted from the desktop catalog in the person's language. Rust
/// holds no user-facing text (the same rule as `locale_menu_set`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrayLabels {
    /// The heading above the running jobs.
    pub running: String,
    /// The line shown instead of the jobs when none is running.
    pub none: String,
    pub new_message: String,
    /// 「모두 읽음 처리」 (#5195).
    pub read_all: String,
    pub open: String,
    pub quit: String,
}

/// One running job.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrayRunRow {
    /// The page's token for this job; comes back in `TrayAction::Run`.
    pub id: String,
    /// The job's name (an agent's or a session's). Cleaned and cut here.
    pub title: String,
    /// The state word in the person's language ("working", "waiting"), appended to the name.
    pub state: String,
}

/// The state of the moment. Every push carries all of it, so the shell keeps nothing the page has
/// to remember to take back.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrayStatus {
    /// The Dock badge's number (`useDockBadgeCount`). Only `> 0` matters here.
    pub unread: u32,
    /// Whether 「새 메시지」 can do anything right now (the app shell is up).
    pub compose: bool,
    /// Whether 「모두 읽음 처리」 has anything to do: an unread mention or DM exists (#5195). The page
    /// derives this from the very list its pick will mark, so the item is enabled exactly when picking
    /// it does something.
    pub read_all: bool,
    pub labels: TrayLabels,
    /// At most [`MAX_RUN_ROWS`], most urgent first.
    pub running: Vec<TrayRunRow>,
    /// The line that says how many more jobs run than the rows show; `None` when all are listed.
    pub more: Option<String>,
    /// What 「모두 읽음 처리」 leaves: the approvals and answers that close only by a decision (#5195).
    /// A dimmed line under that item; `None` when nothing is left.
    pub remaining: Option<String>,
}

// ---- what the shell draws ----------------------------------------------------------------------

/// One line of the menu, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    /// A dimmed line that names the section below it.
    Header(String),
    /// A dimmed line of plain text (nothing is running, how many more there are).
    Note(String),
    /// A line the person can pick. `id` comes back in the menu event.
    Item {
        id: String,
        text: String,
        enabled: bool,
    },
    Separator,
    /// macOS's own Quit item with this text. It has no id of ours: AppKit handles it.
    Quit(String),
}

/// The menu and which of the two icons goes with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuModel {
    /// The icon with the dot.
    pub unread: bool,
    /// The page's app shell is up (someone is signed in): 「새 메시지」 and 「모두 읽음 처리」 can act, and
    /// closing the window may leave the app running (`TrayState::keeps_app_running`).
    pub compose: bool,
    pub entries: Vec<Entry>,
}

/// A character that must not reach a native menu: controls, and the invisible ones that reorder
/// or hide text (bidi embeddings and isolates, zero-width marks, the byte-order mark).
fn is_unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
        )
}

/// A menu word the page formatted: not blank, bounded, and nothing unsafe in it.
fn label_ok(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= MAX_LABEL_BYTES && !text.chars().any(is_unsafe_char)
}

/// `[A-Za-z0-9_-]`, 1..=64 bytes. The id is spliced into a menu id, so it carries no `.`.
fn row_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A name for the menu: unsafe characters become blanks, runs of blanks become one, the ends are
/// trimmed. Empty means nothing was left to show.
fn clean_title(raw: &str) -> String {
    let blanked: String = raw
        .chars()
        .map(|c| if is_unsafe_char(c) { ' ' } else { c })
        .collect();
    blanked.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// At most `max` characters, the last being an ellipsis when something was cut. Counts
/// characters, not bytes, so a Korean or Japanese name is not cut at a third of its length.
fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    // Never end on a blank or on a joiner that expects a character after it.
    let kept = kept.trim_end_matches(|c: char| c.is_whitespace() || c == '\u{200D}');
    format!("{kept}…")
}

/// What the page's status turns into, or the reason it was refused. The reasons are short codes
/// like `locale_menu_set`'s: they are for a developer's console, not for the person.
pub fn build_model(status: &TrayStatus) -> Result<MenuModel, &'static str> {
    let labels = &status.labels;
    for text in [
        &labels.running,
        &labels.none,
        &labels.new_message,
        &labels.read_all,
        &labels.open,
        &labels.quit,
    ] {
        if !label_ok(text) {
            return Err("invalid-tray-label");
        }
    }
    for line in [&status.more, &status.remaining].into_iter().flatten() {
        if !label_ok(line) {
            return Err("invalid-tray-label");
        }
    }
    if status.running.len() > MAX_RUN_ROWS {
        return Err("tray-too-many-rows");
    }

    let mut entries = vec![Entry::Header(labels.running.clone())];
    let mut seen: Vec<&str> = Vec::with_capacity(status.running.len());
    for row in &status.running {
        if !row_id_ok(&row.id) {
            return Err("invalid-tray-row-id");
        }
        if seen.contains(&row.id.as_str()) {
            return Err("duplicate-tray-row-id");
        }
        seen.push(&row.id);
        if row.title.len() > MAX_RAW_TITLE_BYTES || !label_ok(&row.state) {
            return Err("invalid-tray-row");
        }
        let title = clean_title(&row.title);
        if title.is_empty() {
            return Err("invalid-tray-row");
        }
        entries.push(Entry::Item {
            id: format!("{ID_RUN_PREFIX}{}", row.id),
            text: format!(
                "{} · {}",
                truncate_chars(&title, MAX_TITLE_CHARS),
                row.state
            ),
            enabled: true,
        });
    }
    if status.running.is_empty() {
        entries.push(Entry::Note(labels.none.clone()));
    }
    if let Some(more) = &status.more {
        entries.push(Entry::Note(more.clone()));
    }
    entries.extend([
        Entry::Separator,
        Entry::Item {
            id: ID_NEW_MESSAGE.to_owned(),
            text: labels.new_message.clone(),
            enabled: status.compose,
        },
        Entry::Item {
            id: ID_READ_ALL.to_owned(),
            text: labels.read_all.clone(),
            enabled: status.compose && status.read_all,
        },
    ]);
    // Right under the item it explains.
    if let Some(remaining) = &status.remaining {
        entries.push(Entry::Note(remaining.clone()));
    }
    entries.extend([
        Entry::Separator,
        Entry::Item {
            id: ID_OPEN.to_owned(),
            text: labels.open.clone(),
            enabled: true,
        },
        Entry::Separator,
        Entry::Quit(labels.quit.clone()),
    ]);
    Ok(MenuModel {
        unread: status.unread > 0,
        compose: status.compose,
        entries,
    })
}

// ---- the way back ------------------------------------------------------------------------------

/// What the page is told by the menu-bar side. `「oort 열기」` is not here: the shell brings the window
/// forward by itself and the page has nothing to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum TrayAction {
    /// 「새 메시지」: open the new direct message dialog.
    NewMessage,
    /// A running job was picked; `id` is the row id the page sent.
    Run { id: String },
    /// 「모두 읽음 처리」 (#5195): the page marks the unread mentions and DMs read. The window stays
    /// where it is.
    ReadAll,
    /// Not a pick: the red button put the window away into the menu bar (`main_window.rs`, #5196). The
    /// page says once that the app is still here.
    WindowHidden,
}

/// What a picked menu id means.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Click {
    /// Bring the window forward; no event.
    Open,
    /// Tell the page, and bring the window forward unless the action is done where the person is.
    Action(TrayAction),
}

impl Click {
    /// Every pick is a way back into the app, so it brings the window forward — except 「모두 읽음 처리」
    /// (#5195): clearing the dot from the menu bar must not pop a window up in front of whatever the
    /// person is doing, least of all one they just put away.
    pub fn brings_window_forward(&self) -> bool {
        !matches!(self, Click::Action(TrayAction::ReadAll))
    }
}

/// A menu id this module made, read back. Anything else is `None` and is ignored.
pub fn parse_menu_id(id: &str) -> Option<Click> {
    match id {
        ID_OPEN => Some(Click::Open),
        ID_NEW_MESSAGE => Some(Click::Action(TrayAction::NewMessage)),
        ID_READ_ALL => Some(Click::Action(TrayAction::ReadAll)),
        _ => {
            let row = id.strip_prefix(ID_RUN_PREFIX)?;
            row_id_ok(row).then(|| Click::Action(TrayAction::Run { id: row.to_owned() }))
        }
    }
}

/// A pick in the tray menu. Every pick but 「모두 읽음 처리」 brings the window forward (the menu is a
/// way back into the app, and the window may be put away since #5196); the ones that need the page also
/// tell it, as a global emit like the other events.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(click) = parse_menu_id(id) else {
        return;
    };
    if click.brings_window_forward() {
        main_window::bring_forward(app);
    }
    if let Click::Action(action) = click {
        if let Err(error) = app.emit(TRAY_ACTION_EVENT, &action) {
            eprintln!("[oort] tray action not delivered: {error}");
        }
    }
}

// ---- what a new status changes -----------------------------------------------------------------

/// What a new model asks of the status item that already shows `last`. Decided apart from AppKit so it
/// can be measured: replacing a menu the person has open would be felt, and swapping the icon redraws
/// it, so neither happens unless something they show actually changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Change {
    /// The menu's rows or words differ.
    pub menu: bool,
    /// The dot appeared or went.
    pub icon: bool,
}

/// `last` is `None` before the first status: everything is new.
pub fn change_for(last: Option<&MenuModel>, next: &MenuModel) -> Change {
    match last {
        None => Change {
            menu: true,
            icon: true,
        },
        Some(last) => Change {
            menu: last.entries != next.entries,
            icon: last.unread != next.unread,
        },
    }
}

// ---- the command -------------------------------------------------------------------------------

/// The icon and the menu this shell last drew, so the same status twice changes nothing on screen
/// (replacing a menu the person has open would be felt) and the icon is swapped only when the dot
/// appears or goes.
#[derive(Default)]
pub struct TrayState {
    #[cfg(target_os = "macos")]
    applied: std::sync::Mutex<Applied>,
    /// The app can live without its window: the icon is up and the page's app shell is up. Written where
    /// the model it follows is stored (`apply`), read by the close decision (`main_window.rs`).
    staying: AtomicBool,
}

impl TrayState {
    /// Whether closing the window may leave the app running: the menu-bar icon exists (the only way back
    /// besides the Dock) and someone is signed in (otherwise nothing is left to run for). Always `false`
    /// off macOS, where no icon is drawn.
    pub fn keeps_app_running(&self) -> bool {
        self.staying.load(Ordering::SeqCst)
    }

    /// Tests set the answer by hand: the real one needs a status item.
    #[cfg(test)]
    pub fn set_staying_for_test(&self, staying: bool) {
        self.staying.store(staying, Ordering::SeqCst);
    }
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct Applied {
    tray: Option<tauri::tray::TrayIcon>,
    last: Option<MenuModel>,
}

/// Draws the menu-bar icon and its menu from the page's state (#5193). The icon is created by the
/// first valid push (the language is known by then: the menu never shows a word that is not the
/// person's) and lives until the app exits. A refused status leaves what is on screen as it was.
///
/// Granted to the `main` window only (`capabilities/default.json`). A plain, non-async command: it
/// runs on the main thread, where AppKit objects may be made.
#[tauri::command]
pub fn tray_status_set(
    #[allow(unused_variables)] app: AppHandle,
    #[allow(unused_variables)] state: tauri::State<'_, TrayState>,
    status: TrayStatus,
) -> Result<(), String> {
    let model = build_model(&status).map_err(str::to_owned)?;
    #[cfg(target_os = "macos")]
    {
        apply(&app, &state, model)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = model;
        Ok(())
    }
}

/// The id of the one status item. A fixed id so a second `build` could never leave two icons.
#[cfg(target_os = "macos")]
const TRAY_ID: &str = "oort";

// The two template bitmaps (36x36, black + alpha). `tests` also reads the 18x18 pair.
#[cfg(target_os = "macos")]
const ICON_PLAIN: &[u8] = include_bytes!("../icons/tray/oort-tray@2x.png");
#[cfg(target_os = "macos")]
const ICON_UNREAD: &[u8] = include_bytes!("../icons/tray/oort-tray-unread@2x.png");

/// One embedded PNG as straight RGBA. The bitmaps are made by `render_tray_icons.sh` as 8-bit RGBA;
/// anything else is a build mistake and is refused rather than drawn wrong.
#[cfg(target_os = "macos")]
fn decode_png(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
        .read_info()
        .map_err(|_| "tray-icon-invalid".to_owned())?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| "tray-icon-invalid".to_owned())?;
    let mut rgba = vec![0; size];
    let info = reader
        .next_frame(&mut rgba)
        .map_err(|_| "tray-icon-invalid".to_owned())?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return Err("tray-icon-invalid".to_owned());
    }
    rgba.truncate(info.buffer_size());
    Ok((rgba, info.width, info.height))
}

#[cfg(target_os = "macos")]
fn icon(unread: bool) -> Result<tauri::image::Image<'static>, String> {
    let (rgba, width, height) = decode_png(if unread { ICON_UNREAD } else { ICON_PLAIN })?;
    Ok(tauri::image::Image::new_owned(rgba, width, height))
}

/// The menu as native items, in the model's order. The text of a model entry is the text drawn.
#[cfg(target_os = "macos")]
fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    model: &MenuModel,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};

    let mut items: Vec<Box<dyn IsMenuItem<R>>> = Vec::with_capacity(model.entries.len());
    for entry in &model.entries {
        match entry {
            Entry::Header(text) | Entry::Note(text) => {
                items.push(Box::new(MenuItem::new(app, text, false, None::<&str>)?))
            }
            Entry::Item { id, text, enabled } => items.push(Box::new(MenuItem::with_id(
                app,
                id.as_str(),
                text,
                *enabled,
                None::<&str>,
            )?)),
            Entry::Separator => items.push(Box::new(PredefinedMenuItem::separator(app)?)),
            Entry::Quit(text) => items.push(Box::new(PredefinedMenuItem::quit(app, Some(text))?)),
        }
    }
    let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(|item| item.as_ref()).collect();
    Menu::with_items(app, &refs)
}

#[cfg(target_os = "macos")]
fn apply(app: &AppHandle, state: &TrayState, model: MenuModel) -> Result<(), String> {
    use tauri::tray::TrayIconBuilder;

    let mut applied = state
        .applied
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let change = change_for(applied.last.as_ref(), &model);
    if !change.menu && !change.icon {
        return Ok(());
    }
    match &applied.tray {
        Some(tray) => {
            if change.menu {
                let menu = build_menu(app, &model).map_err(|_| "tray-menu-failed".to_owned())?;
                tray.set_menu(Some(menu))
                    .map_err(|_| "tray-menu-failed".to_owned())?;
            }
            if change.icon {
                tray.set_icon_with_as_template(Some(icon(model.unread)?), true)
                    .map_err(|_| "tray-icon-failed".to_owned())?;
            }
        }
        None => {
            let menu = build_menu(app, &model).map_err(|_| "tray-menu-failed".to_owned())?;
            // Left and right click open the same menu: the status item's own menu (tray-icon opens it
            // for both buttons by default).
            let tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(icon(model.unread)?)
                .icon_as_template(true)
                .tooltip(&app.package_info().name)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
                .build(app)
                .map_err(|_| "tray-create-failed".to_owned())?;
            applied.tray = Some(tray);
        }
    }
    state.staying.store(model.compose, Ordering::SeqCst);
    applied.last = Some(model);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn labels() -> TrayLabels {
        TrayLabels {
            running: "Running".into(),
            none: "Nothing running".into(),
            new_message: "New message".into(),
            read_all: "Mark all as read".into(),
            open: "Open oort".into(),
            quit: "Quit oort".into(),
        }
    }

    fn row(id: &str, title: &str, state: &str) -> TrayRunRow {
        TrayRunRow {
            id: id.into(),
            title: title.into(),
            state: state.into(),
        }
    }

    fn status(unread: u32, running: Vec<TrayRunRow>) -> TrayStatus {
        TrayStatus {
            unread,
            compose: true,
            read_all: true,
            labels: labels(),
            running,
            more: None,
            remaining: None,
        }
    }

    fn texts(model: &MenuModel) -> Vec<String> {
        model
            .entries
            .iter()
            .map(|entry| match entry {
                Entry::Header(t) | Entry::Note(t) | Entry::Quit(t) => t.clone(),
                Entry::Item { text, .. } => text.clone(),
                Entry::Separator => "---".into(),
            })
            .collect()
    }

    // ---- the menu by what is running ----

    #[test]
    fn nothing_running_says_so_on_a_dimmed_line() {
        let model = build_model(&status(0, vec![])).unwrap();
        assert_eq!(
            texts(&model),
            [
                "Running",
                "Nothing running",
                "---",
                "New message",
                "Mark all as read",
                "---",
                "Open oort",
                "---",
                "Quit oort"
            ]
        );
        // The placeholder is a note, not a pickable item.
        assert_eq!(model.entries[1], Entry::Note("Nothing running".into()));
    }

    #[test]
    fn one_running_job_is_one_pickable_row_with_its_state() {
        let model = build_model(&status(0, vec![row("r1", "김인턴", "작업 중")])).unwrap();
        assert_eq!(model.entries[0], Entry::Header("Running".into()));
        assert_eq!(
            model.entries[1],
            Entry::Item {
                id: "tray.run.r1".into(),
                text: "김인턴 · 작업 중".into(),
                enabled: true
            }
        );
        // No placeholder next to a real row.
        assert!(!model
            .entries
            .contains(&Entry::Note("Nothing running".into())));
    }

    #[test]
    fn many_running_jobs_keep_their_order_and_the_overflow_line_follows() {
        let rows: Vec<_> = (0..MAX_RUN_ROWS)
            .map(|i| row(&format!("r{i}"), &format!("agent {i}"), "waiting"))
            .collect();
        let mut s = status(0, rows);
        s.more = Some("and 4 more".into());
        let model = build_model(&s).unwrap();
        let listed: Vec<_> = model
            .entries
            .iter()
            .filter_map(|e| match e {
                Entry::Item { id, .. } if id.starts_with("tray.run.") => Some(id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            listed,
            [
                "tray.run.r0",
                "tray.run.r1",
                "tray.run.r2",
                "tray.run.r3",
                "tray.run.r4",
                "tray.run.r5"
            ]
        );
        // The dimmed overflow line sits right after the last row.
        let last_row = model
            .entries
            .iter()
            .rposition(|e| matches!(e, Entry::Item { id, .. } if id.starts_with("tray.run.")))
            .unwrap();
        assert_eq!(
            model.entries[last_row + 1],
            Entry::Note("and 4 more".into())
        );
    }

    // ---- the dot ----

    #[test]
    fn the_dot_follows_the_badge_number_and_only_whether_it_is_above_zero() {
        for (unread, dot) in [
            (0, false),
            (1, true),
            (7, true),
            (999, true),
            (u32::MAX, true),
        ] {
            assert_eq!(
                build_model(&status(unread, vec![])).unwrap().unread,
                dot,
                "{unread}"
            );
        }
    }

    #[test]
    fn new_message_is_enabled_only_while_the_app_shell_is_up() {
        for compose in [true, false] {
            let mut s = status(0, vec![]);
            s.compose = compose;
            let model = build_model(&s).unwrap();
            let item = model
                .entries
                .iter()
                .find_map(|e| match e {
                    Entry::Item { id, enabled, .. } if id == "tray.new-message" => Some(*enabled),
                    _ => None,
                })
                .unwrap();
            assert_eq!(item, compose);
        }
    }

    // ---- 「모두 읽음 처리」 (#5195) ----

    fn item_enabled(model: &MenuModel, wanted: &str) -> bool {
        model
            .entries
            .iter()
            .find_map(|e| match e {
                Entry::Item { id, enabled, .. } if id == wanted => Some(*enabled),
                _ => None,
            })
            .unwrap_or_else(|| panic!("{wanted} is not in the menu"))
    }

    #[test]
    fn mark_all_read_is_enabled_only_when_there_is_something_to_mark_and_the_shell_is_up() {
        for (compose, read_all, enabled) in [
            (true, true, true),
            (true, false, false),
            (false, true, false),
            (false, false, false),
        ] {
            let mut s = status(0, vec![]);
            s.compose = compose;
            s.read_all = read_all;
            let model = build_model(&s).unwrap();
            assert_eq!(
                item_enabled(&model, "tray.read-all"),
                enabled,
                "compose={compose} read_all={read_all}"
            );
            // 「새 메시지」 does not care about what is unread.
            assert_eq!(item_enabled(&model, "tray.new-message"), compose);
        }
    }

    #[test]
    fn what_mark_all_read_leaves_is_one_dimmed_line_right_under_it_and_nothing_when_nothing_is_left(
    ) {
        let mut s = status(0, vec![]);
        s.remaining = Some("2 approvals are still waiting".into());
        let model = build_model(&s).unwrap();
        let at = model
            .entries
            .iter()
            .position(|e| matches!(e, Entry::Item { id, .. } if id == "tray.read-all"))
            .unwrap();
        assert_eq!(
            model.entries[at + 1],
            Entry::Note("2 approvals are still waiting".into()),
            "a dimmed note, not a pickable line, directly after the item"
        );
        assert_eq!(model.entries[at + 2], Entry::Separator);
        // Nothing left: no line at all (not an empty one).
        let none = build_model(&status(0, vec![])).unwrap();
        let at = none
            .entries
            .iter()
            .position(|e| matches!(e, Entry::Item { id, .. } if id == "tray.read-all"))
            .unwrap();
        assert_eq!(none.entries[at + 1], Entry::Separator);
        assert_eq!(
            none.entries.len() + 1,
            model.entries.len(),
            "the line is the only difference"
        );
    }

    // ---- whether the app can stay without its window (#5196) ----

    #[test]
    fn a_menu_model_remembers_whether_someone_is_signed_in_and_a_fresh_state_keeps_nothing() {
        for compose in [true, false] {
            let mut s = status(0, vec![]);
            s.compose = compose;
            assert_eq!(build_model(&s).unwrap().compose, compose);
        }
        // Before the first status there is no icon and nobody is signed in: the red button ends the app.
        assert!(!TrayState::default().keeps_app_running());
    }

    // ---- long and odd titles ----

    #[test]
    fn a_long_title_is_cut_with_an_ellipsis_and_its_state_is_kept() {
        let long = "가".repeat(80);
        let model = build_model(&status(0, vec![row("r1", &long, "승인 대기")])).unwrap();
        let Entry::Item { text, .. } = &model.entries[1] else {
            panic!("row expected");
        };
        let (name, state) = text.split_once(" · ").unwrap();
        assert_eq!(name.chars().count(), MAX_TITLE_CHARS);
        assert!(name.ends_with('…'));
        assert!(name.starts_with("가가가"));
        assert_eq!(state, "승인 대기");
    }

    #[test]
    fn a_title_at_the_limit_is_not_touched() {
        let exact = "a".repeat(MAX_TITLE_CHARS);
        let model = build_model(&status(0, vec![row("r1", &exact, "x")])).unwrap();
        let Entry::Item { text, .. } = &model.entries[1] else {
            panic!("row expected");
        };
        assert_eq!(text, &format!("{exact} · x"));
    }

    #[test]
    fn the_cut_never_ends_on_a_blank_or_a_joiner() {
        // `MAX_TITLE_CHARS - 1` characters kept, the last of them a blank: the blank goes with the cut.
        let title = format!("{} tail words", "a".repeat(MAX_TITLE_CHARS - 2));
        let cut = truncate_chars(&title, MAX_TITLE_CHARS);
        assert_eq!(cut, format!("{}…", "a".repeat(MAX_TITLE_CHARS - 2)));
        let joiner = format!("{}\u{200D}zzzz", "b".repeat(MAX_TITLE_CHARS - 2));
        assert_eq!(
            truncate_chars(&joiner, MAX_TITLE_CHARS),
            format!("{}…", "b".repeat(MAX_TITLE_CHARS - 2))
        );
    }

    #[test]
    fn unsafe_characters_in_a_title_become_blanks_and_blanks_collapse() {
        // A newline, a right-to-left override, a zero-width space and a tab.
        let model = build_model(&status(
            0,
            vec![row("r1", "  김\n인턴\u{202E}x\u{200B}y\t z  ", "작업 중")],
        ))
        .unwrap();
        let Entry::Item { text, .. } = &model.entries[1] else {
            panic!("row expected");
        };
        assert_eq!(text, "김 인턴 x y z · 작업 중");
        assert!(!text.chars().any(is_unsafe_char));
    }

    // ---- the input limits ----

    #[test]
    fn more_rows_than_the_limit_are_refused() {
        let rows: Vec<_> = (0..=MAX_RUN_ROWS)
            .map(|i| row(&format!("r{i}"), "a", "s"))
            .collect();
        assert_eq!(build_model(&status(0, rows)), Err("tray-too-many-rows"));
        let ok: Vec<_> = (0..MAX_RUN_ROWS)
            .map(|i| row(&format!("r{i}"), "a", "s"))
            .collect();
        assert!(build_model(&status(0, ok)).is_ok());
    }

    #[test]
    fn a_menu_word_that_is_blank_long_or_unsafe_is_refused() {
        type Set = fn(&mut TrayStatus, String);
        let setters: [(&str, Set); 8] = [
            ("running", |s, v| s.labels.running = v),
            ("none", |s, v| s.labels.none = v),
            ("newMessage", |s, v| s.labels.new_message = v),
            ("readAll", |s, v| s.labels.read_all = v),
            ("open", |s, v| s.labels.open = v),
            ("quit", |s, v| s.labels.quit = v),
            ("more", |s, v| s.more = Some(v)),
            ("remaining", |s, v| s.remaining = Some(v)),
        ];
        for (name, set) in setters {
            for bad in [
                "".to_owned(),
                "   ".to_owned(),
                "x".repeat(MAX_LABEL_BYTES + 1),
                "a\nb".to_owned(),
                "a\u{202E}b".to_owned(),
            ] {
                let mut s = status(0, vec![]);
                set(&mut s, bad.clone());
                assert_eq!(
                    build_model(&s),
                    Err("invalid-tray-label"),
                    "{name} = {bad:?}"
                );
            }
            // The limit itself is fine.
            let mut s = status(0, vec![]);
            set(&mut s, "x".repeat(MAX_LABEL_BYTES));
            assert!(build_model(&s).is_ok(), "{name} at the limit");
        }
    }

    #[test]
    fn a_row_id_must_be_a_plain_bounded_token_and_unique() {
        for bad in [
            "",
            "a b",
            "a.b",
            "a:b",
            "한글",
            &"x".repeat(MAX_ID_BYTES + 1),
        ] {
            assert_eq!(
                build_model(&status(0, vec![row(bad, "a", "s")])),
                Err("invalid-tray-row-id"),
                "{bad:?}"
            );
        }
        let long_ok = "x".repeat(MAX_ID_BYTES);
        assert!(build_model(&status(0, vec![row(&long_ok, "a", "s")])).is_ok());
        assert_eq!(
            build_model(&status(0, vec![row("r1", "a", "s"), row("r1", "b", "s")])),
            Err("duplicate-tray-row-id")
        );
    }

    #[test]
    fn a_row_without_a_name_or_a_state_is_refused() {
        for (title, state) in [("", "s"), (" \n\u{200B}", "s"), ("a", ""), ("a", "  ")] {
            assert_eq!(
                build_model(&status(0, vec![row("r1", title, state)])),
                Err("invalid-tray-row"),
                "{title:?} / {state:?}"
            );
        }
        let huge = "x".repeat(MAX_RAW_TITLE_BYTES + 1);
        assert_eq!(
            build_model(&status(0, vec![row("r1", &huge, "s")])),
            Err("invalid-tray-row")
        );
    }

    // ---- what a new status changes ----

    #[test]
    fn the_same_status_twice_changes_nothing_and_a_dot_or_a_row_changes_only_its_own_part() {
        let a = build_model(&status(0, vec![row("0", "a", "s")])).unwrap();
        // First status: everything is new.
        assert_eq!(
            change_for(None, &a),
            Change {
                menu: true,
                icon: true
            }
        );
        // The same again: nothing is touched (an open menu is not replaced).
        assert_eq!(
            change_for(Some(&a), &a.clone()),
            Change {
                menu: false,
                icon: false
            }
        );
        // A row came: the menu changes, the icon does not.
        let more = build_model(&status(0, vec![row("0", "a", "s"), row("1", "b", "s")])).unwrap();
        assert_eq!(
            change_for(Some(&a), &more),
            Change {
                menu: true,
                icon: false
            }
        );
        // The dot appeared with the same rows: the icon changes, the menu does not.
        let dotted = build_model(&status(5, vec![row("0", "a", "s")])).unwrap();
        assert_eq!(
            change_for(Some(&a), &dotted),
            Change {
                menu: false,
                icon: true
            }
        );
        // A different number above zero is not a different icon.
        let more_unread = build_model(&status(9, vec![row("0", "a", "s")])).unwrap();
        assert_eq!(
            change_for(Some(&dotted), &more_unread),
            Change {
                menu: false,
                icon: false
            }
        );
    }

    // ---- the wire ----

    /// What the page sends, written down once in `tests/fixtures/tray_status.json` and read by both
    /// sides: `trayModel.test.ts` builds a status with the page's own code and requires exactly
    /// this JSON, and this test requires the shell to accept exactly this JSON. A renamed or added
    /// field on one side only fails on that side's CI; `deny_unknown_fields` makes the shell refuse
    /// what it does not know, so a field the page adds alone would otherwise be a refused status
    /// seen only in the running app.
    const PAGE_STATUS: &str = include_str!("../tests/fixtures/tray_status.json");

    #[test]
    fn the_status_the_page_sends_is_what_the_shell_accepts_and_the_wire_is_closed() {
        let json: serde_json::Value = serde_json::from_str(PAGE_STATUS).unwrap();
        let parsed: TrayStatus = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(parsed.unread, 3);
        assert_eq!(parsed.running[0].title, "김인턴");
        assert_eq!(parsed.running[1].state, "Working");
        assert!(parsed.more.is_none());
        assert!(parsed.read_all);
        assert_eq!(
            parsed.remaining.as_deref(),
            Some("2 approvals are still waiting")
        );
        let model = build_model(&parsed).unwrap();
        assert!(model.unread);
        assert_eq!(
            texts(&model),
            [
                "Running",
                "김인턴 · Waiting",
                "codex · Working",
                "---",
                "New message",
                "Mark all as read",
                "2 approvals are still waiting",
                "---",
                "Open oort",
                "---",
                "Quit oort"
            ]
        );

        let mut extra = json.clone();
        extra["surprise"] = serde_json::json!(1);
        assert!(serde_json::from_value::<TrayStatus>(extra).is_err());
        let mut extra_row = json.clone();
        extra_row["running"][0]["badge"] = serde_json::json!(1);
        assert!(serde_json::from_value::<TrayStatus>(extra_row).is_err());
        let mut extra_labels = json;
        extra_labels["labels"]["tooltip"] = serde_json::json!("x");
        assert!(serde_json::from_value::<TrayStatus>(extra_labels).is_err());
    }

    /// The one limit the page mirrors, written once in `tests/fixtures/tray_limits.json` and read by
    /// both sides (`trayModel.test.ts` requires the page's `TRAY_MAX_ROWS` to be this number). A shell
    /// that lowers the limit alone would refuse every status that lists the old number of rows, and the
    /// menu would stop where it was; this fails first.
    #[test]
    fn the_row_limit_the_page_mirrors_is_the_shells() {
        let limits: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/tray_limits.json")).unwrap();
        assert_eq!(limits["maxRunRows"], MAX_RUN_ROWS);
    }

    // ---- the way back ----

    #[test]
    fn every_menu_id_the_model_makes_reads_back_as_what_it_was() {
        let rows = vec![row("r1", "a", "s"), row("job_2-x", "b", "s")];
        let model = build_model(&status(0, rows)).unwrap();
        let mut seen = 0;
        for entry in &model.entries {
            if let Entry::Item { id, .. } = entry {
                seen += 1;
                let click = parse_menu_id(id).unwrap_or_else(|| panic!("{id} does not read back"));
                match id.as_str() {
                    "tray.open" => assert_eq!(click, Click::Open),
                    "tray.new-message" => assert_eq!(click, Click::Action(TrayAction::NewMessage)),
                    "tray.read-all" => assert_eq!(click, Click::Action(TrayAction::ReadAll)),
                    other => assert_eq!(
                        click,
                        Click::Action(TrayAction::Run {
                            id: other.strip_prefix("tray.run.").unwrap().to_owned()
                        })
                    ),
                }
            }
        }
        assert_eq!(seen, 5, "two rows, new message, mark all read, open");
    }

    #[test]
    fn a_menu_id_that_is_not_ours_is_ignored() {
        for id in [
            "",
            "quit",
            "tray",
            "tray.run.",
            "tray.run.a b",
            "tray.run.a.b",
            "tray.run./etc",
            "tray.runx",
            "tray.open ",
            "app.run.r1",
        ] {
            assert_eq!(parse_menu_id(id), None, "{id:?}");
        }
        assert_eq!(
            parse_menu_id(&format!("tray.run.{}", "x".repeat(MAX_ID_BYTES + 1))),
            None
        );
    }

    /// The page listens for this exact name (`DESKTOP_EVENT.trayAction`). The test below listens by
    /// the constant, so only a literal here can notice a rename.
    #[test]
    fn the_event_name_is_the_one_the_page_listens_for() {
        assert_eq!(TRAY_ACTION_EVENT, "momo:tray-action");
    }

    /// The page reads these words; a rename here is an action it never recognises.
    #[test]
    fn the_event_payload_is_the_one_the_page_reads() {
        assert_eq!(
            serde_json::to_value(TrayAction::NewMessage).unwrap(),
            serde_json::json!({ "action": "new-message" })
        );
        assert_eq!(
            serde_json::to_value(TrayAction::Run { id: "r1".into() }).unwrap(),
            serde_json::json!({ "action": "run", "id": "r1" })
        );
        assert_eq!(
            serde_json::to_value(TrayAction::ReadAll).unwrap(),
            serde_json::json!({ "action": "read-all" })
        );
        assert_eq!(
            serde_json::to_value(TrayAction::WindowHidden).unwrap(),
            serde_json::json!({ "action": "window-hidden" })
        );
    }

    /// Every pick is a way back into the app and brings the window forward, except 「모두 읽음 처리」:
    /// the Rust side of it is decided here, the page's side is a mock-bus test below.
    #[test]
    fn every_pick_brings_the_window_forward_except_mark_all_read() {
        for (id, forward) in [
            ("tray.open", true),
            ("tray.new-message", true),
            ("tray.run.job-7", true),
            ("tray.read-all", false),
        ] {
            let click = parse_menu_id(id).unwrap();
            assert_eq!(click.brings_window_forward(), forward, "{id}");
        }
        let app = tauri::test::mock_app();
        for (id, forward) in [
            ("tray.open", 1),
            ("tray.new-message", 1),
            ("tray.read-all", 0),
            ("something.else", 0),
        ] {
            let before = main_window::forwarded();
            handle_menu_event(app.handle(), id);
            assert_eq!(main_window::forwarded() - before, forward, "{id}");
        }
    }

    /// Through Tauri's real event bus (the mock runtime), listened to the way the page does
    /// (`listen_any`): the name is a valid event name, a pick that needs the page arrives once with
    /// exactly the payload above, and the picks that do not need it (open, a foreign id) send nothing.
    #[test]
    fn a_pick_reaches_a_page_listener_once_and_open_and_strangers_send_nothing() {
        use tauri::Listener;

        let app = tauri::test::mock_app();
        let (tx, rx) = mpsc::channel();
        app.listen_any(TRAY_ACTION_EVENT, move |event| {
            tx.send(event.payload().to_owned()).unwrap();
        });

        handle_menu_event(app.handle(), "tray.new-message");
        handle_menu_event(app.handle(), "tray.run.job-7");
        handle_menu_event(app.handle(), "tray.open");
        handle_menu_event(app.handle(), "tray.read-all");
        handle_menu_event(app.handle(), "tray.run.has space");
        handle_menu_event(app.handle(), "something.else");

        let wait = std::time::Duration::from_secs(5);
        let first: serde_json::Value =
            serde_json::from_str(&rx.recv_timeout(wait).unwrap()).unwrap();
        let second: serde_json::Value =
            serde_json::from_str(&rx.recv_timeout(wait).unwrap()).unwrap();
        let third: serde_json::Value =
            serde_json::from_str(&rx.recv_timeout(wait).unwrap()).unwrap();
        assert_eq!(first, serde_json::json!({ "action": "new-message" }));
        assert_eq!(
            second,
            serde_json::json!({ "action": "run", "id": "job-7" })
        );
        assert_eq!(third, serde_json::json!({ "action": "read-all" }));
        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod icon_tests {
    use super::*;

    const PLAIN_1X: &[u8] = include_bytes!("../icons/tray/oort-tray.png");
    const PLAIN_2X: &[u8] = include_bytes!("../icons/tray/oort-tray@2x.png");
    const UNREAD_1X: &[u8] = include_bytes!("../icons/tray/oort-tray-unread.png");
    const UNREAD_2X: &[u8] = include_bytes!("../icons/tray/oort-tray-unread@2x.png");

    fn pixels(bytes: &[u8], side: u32) -> Vec<[u8; 4]> {
        let (rgba, width, height) = decode_png(bytes).unwrap();
        assert_eq!((width, height), (side, side));
        rgba.chunks_exact(4)
            .map(|p| [p[0], p[1], p[2], p[3]])
            .collect()
    }

    /// A template image is read by its alpha alone, and the mark must be there at all: black ink
    /// (RGB 0 wherever there is any), some of the canvas covered and some left clear.
    #[test]
    fn both_densities_of_both_icons_are_black_ink_with_alpha_and_not_blank_or_solid() {
        for (bytes, side) in [
            (PLAIN_1X, 18),
            (PLAIN_2X, 36),
            (UNREAD_1X, 18),
            (UNREAD_2X, 36),
        ] {
            let px = pixels(bytes, side);
            assert!(px.iter().filter(|p| p[3] > 0).all(|p| p[..3] == [0, 0, 0]));
            let inked = px.iter().filter(|p| p[3] > 0).count();
            let opaque = px.iter().filter(|p| p[3] == 255).count();
            let total = px.len();
            assert!(
                opaque > total / 8,
                "the mark is there ({side}px: {opaque}/{total})"
            );
            assert!(
                inked < total * 3 / 4,
                "the canvas is not filled ({side}px: {inked}/{total})"
            );
        }
    }

    /// The dot is an addition: nothing the plain mark inks is lost in the unread one, and what is
    /// added sits in the bottom-right corner the mark leaves free — so the mark does not move or
    /// change when the dot comes and goes.
    #[test]
    fn the_unread_icon_is_the_plain_mark_plus_a_dot_in_the_free_corner() {
        for (plain, unread, side) in [(PLAIN_1X, UNREAD_1X, 18usize), (PLAIN_2X, UNREAD_2X, 36)] {
            let a = pixels(plain, side as u32);
            let b = pixels(unread, side as u32);
            let mut added = Vec::new();
            for (i, (p, u)) in a.iter().zip(&b).enumerate() {
                assert!(u[3] >= p[3], "the dot removed ink at {i}");
                if u[3] != p[3] {
                    added.push((i % side, i / side));
                }
            }
            assert!(
                added.len() >= side / 3,
                "{side}px: a dot has some area ({} px)",
                added.len()
            );
            // Bottom-right quadrant, nearer the corner than the ring's own bounding box.
            let from = side * 2 / 3;
            assert!(
                added.iter().all(|&(x, y)| x >= from && y >= from),
                "{side}px: ink added outside the corner: {added:?}"
            );
        }
    }

    /// `tray_status_set` decodes the @2x files, so the same decode must accept them and must refuse
    /// what is not 8-bit RGBA.
    #[test]
    fn the_decoder_reads_the_embedded_files_and_refuses_anything_else() {
        assert!(decode_png(PLAIN_2X).is_ok());
        assert!(decode_png(UNREAD_2X).is_ok());
        assert_eq!(
            decode_png(b"not a png"),
            Err("tray-icon-invalid".to_owned())
        );
        assert_eq!(
            decode_png(&PLAIN_2X[..40]),
            Err("tray-icon-invalid".to_owned())
        );
        // A valid PNG that is not RGBA (1x1 grayscale) is refused, not drawn with the wrong channels.
        let mut gray = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut gray, 1, 1);
            enc.set_color(png::ColorType::Grayscale);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().unwrap();
            w.write_image_data(&[0]).unwrap();
        }
        assert_eq!(decode_png(&gray), Err("tray-icon-invalid".to_owned()));
    }
}
