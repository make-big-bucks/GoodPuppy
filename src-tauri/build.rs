fn main() {
    println!("cargo:rerun-if-env-changed=GOODPUPPY_UPDATER_PUBLIC_KEY");
    tauri_build::build()
}
