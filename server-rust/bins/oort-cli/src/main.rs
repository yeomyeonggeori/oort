fn main() {
    std::process::exit(oort_cli::run(
        std::env::args_os(),
        oort_cli::Env::from_process(),
    ));
}
