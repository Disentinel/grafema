// Build script для правильной линковки с Node.js N-API

fn main() {
    // Для napi feature нужны специальные настройки линковки
    #[cfg(feature = "napi")]
    {
        // На macOS нужно разрешить undefined symbols для N-API
        // Они будут предоставлены Node.js во время runtime
        if cfg!(target_os = "macos") {
            println!("cargo:rustc-cdylib-link-arg=-undefined");
            println!("cargo:rustc-cdylib-link-arg=dynamic_lookup");
        }

        // На Linux используем --unresolved-symbols=ignore-all
        if cfg!(target_os = "linux") {
            println!("cargo:rustc-cdylib-link-arg=-Wl,--unresolved-symbols=ignore-all");
        }
    }
}
