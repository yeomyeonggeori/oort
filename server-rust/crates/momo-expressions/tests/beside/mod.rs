//! The default entries of `momo_expressions` (`media::process`, `media::prepare_photo`,
//! `media::process_cutout`, `assemble::try_assemble`, ...) run their child program from beside the
//! running executable, one level above a `deps` directory: a deployment installs the children beside
//! the server. Where cargo puts a test executable is not promised (`target/debug/deps/`, or a
//! per-unit directory of its own), but `CARGO_BIN_EXE_<name>` always names the bin it built for
//! this test. So a test that calls a default entry first puts that bin where the entry looks.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Make `name` beside this executable (one level above `deps`) be `built`, the
/// `CARGO_BIN_EXE_<name>` of this test, and return that place. When cargo already built it there
/// nothing is touched; otherwise a symlink to `built` is renamed into place, so a test running
/// beside this one (a thread, or another process under nextest) never sees a half-made file, and
/// a rebuilt bin is what the next run finds. A real file that is not `built` is never replaced.
pub fn place(name: &str, built: &Path) -> PathBuf {
    let exe = std::env::current_exe().expect("test executable");
    let mut dir = exe.parent().expect("test directory").to_path_buf();
    if dir.file_name() == Some(std::ffi::OsStr::new("deps")) {
        dir.pop();
    }
    let at = dir.join(name);
    let built_real = std::fs::canonicalize(built).expect("the bin cargo built for this test");
    if std::fs::canonicalize(&at).ok().as_ref() == Some(&built_real) {
        return at;
    }
    if let Ok(meta) = std::fs::symlink_metadata(&at) {
        assert!(
            meta.file_type().is_symlink(),
            "{at:?} is a file that is not {built:?}: not replacing it"
        );
    }
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let tmp = dir.join(format!(
        ".{name}.{}.{}.link",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_file(&tmp);
    std::os::unix::fs::symlink(&built_real, &tmp).expect("link the built bin");
    std::fs::rename(&tmp, &at).expect("put the link in place");
    at
}
