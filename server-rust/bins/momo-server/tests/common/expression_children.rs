//! The child programs of `momo_expressions` (`momo-expression-decoder`, `momo-expression-assembler`)
//! are run from beside the running executable, one level above a `deps` directory, unless an
//! `OORT_EXPRESSION_*` override names them. They are bins of `momo-expressions`, so a test of
//! another package has no `CARGO_BIN_EXE_*` for them: `cargo build -p momo-expressions --bins` (or
//! a workspace build) leaves them in the profile directory (`target/debug/`). An older cargo runs
//! this test from `target/debug/deps/`, so they are already where the entry looks; a newer one runs
//! it from a directory of its own below the profile directory (`target/debug/build/<package>/<hash>/out/`),
//! so the test puts a link to the built program there first (the same `place` the
//! `momo-expressions` tests use). Nothing here changes how the product finds them.

use std::path::PathBuf;

#[path = "../../../../crates/momo-expressions/tests/beside/mod.rs"]
mod beside;

/// The place the default entry of `momo_expressions` runs the child `name` from, once it is
/// there: `Ok(place)`, or `Err(place)` when no build of it is beside this executable or in the
/// profile directory above it (the nearest of the four directories above that holds cargo's
/// `.cargo-lock`).
pub fn ready(name: &str) -> Result<PathBuf, PathBuf> {
    let exe = std::env::current_exe().expect("test executable");
    let mut dir = exe.parent().expect("test directory").to_path_buf();
    if dir.file_name() == Some(std::ffi::OsStr::new("deps")) {
        dir.pop();
    }
    let at = dir.join(name);
    if at.is_file() {
        return Ok(at);
    }
    let built = dir
        .ancestors()
        .skip(1)
        .take(4)
        .find(|d| d.join(".cargo-lock").is_file())
        .map(|profile| profile.join(name))
        .filter(|built| built.is_file());
    match built {
        Some(built) => Ok(beside::place(name, &built)),
        None => Err(at),
    }
}
