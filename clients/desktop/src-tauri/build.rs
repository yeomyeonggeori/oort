fn main() {
    // Channel artifacts are the only builds allowed to talk to the updater
    // manifest (#1281). `cargo tauri build` locally (release, unsigned) still
    // reports `tauri.conf.json`'s baseline version (`0.1.0-next.1`), which the
    // live manifest always outranks — so a local release would otherwise offer
    // to replace newer HEAD with the last published bundle. The publish script
    // is the only path that sets this.
    println!("cargo:rerun-if-env-changed=MOMO_CHANNEL_BUILD");
    println!("cargo:rustc-check-cfg=cfg(momo_channel_build)");
    if std::env::var("MOMO_CHANNEL_BUILD").ok().as_deref() == Some("1") {
        println!("cargo:rustc-cfg=momo_channel_build");
    }
    tauri_build::build()
}
