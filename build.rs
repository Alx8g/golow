use std::{env, path::PathBuf, process::Command};

fn find_rc() -> Option<PathBuf> {
    for name in ["llvm-rc.exe", "rc.exe"] {
        if let Ok(out) = Command::new("where").arg(name).output() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(p) = s.lines().next() {
                let p = p.trim();
                if !p.is_empty() {
                    return Some(PathBuf::from(p));
                }
            }
        }
    }
    None
}

fn main() {
    println!("cargo:rerun-if-changed=assets/icon.ico");
    println!("cargo:rerun-if-changed=assets/icon.png");
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    // Decode once at build time, not during every application launch.
    let decoded = image::open(manifest.join("assets/icon.png"))
        .expect("valid app icon")
        .to_rgba8();
    let (width, height) = decoded.dimensions();
    std::fs::write(out.join("icon.rgba"), decoded.as_raw()).expect("write decoded icon");
    println!("cargo:rustc-env=APP_ICON_WIDTH={width}");
    println!("cargo:rustc-env=APP_ICON_HEIGHT={height}");
    let icon = manifest.join("assets").join("icon.ico");
    let rc_path = out.join("app.rc");
    let res_path = out.join("app.res");
    let version = env::var("CARGO_PKG_VERSION").unwrap();
    let numeric_version = format!("{},0", version.replace('.', ","));
    let rc_content = format!(
        "1 ICON \"{}\"\n\
         1 VERSIONINFO\n\
         FILEVERSION {numeric_version}\n\
         PRODUCTVERSION {numeric_version}\n\
         BEGIN\n\
         \u{20} BLOCK \"StringFileInfo\"\n\
         \u{20} BEGIN\n\
         \u{20}\u{20} BLOCK \"040904E4\"\n\
         \u{20}\u{20} BEGIN\n\
         \u{20}\u{20}\u{20} VALUE \"FileDescription\", \"SoundCloud Go+\"\n\
         \u{20}\u{20}\u{20} VALUE \"ProductName\", \"SoundCloud Go+\"\n\
         \u{20}\u{20}\u{20} VALUE \"FileVersion\", \"{version}\"\n\
         \u{20}\u{20}\u{20} VALUE \"ProductVersion\", \"{version}\"\n\
         \u{20}\u{20}\u{20} VALUE \"OriginalFilename\", \"soundcloud-go-client.exe\"\n\
         \u{20}\u{20} END\n\
         \u{20} END\n\
         \u{20} BLOCK \"VarFileInfo\"\n\
         \u{20} BEGIN\n\
         \u{20}\u{20} VALUE \"Translation\", 0x409, 1252\n\
         \u{20} END\n\
         END\n",
        icon.display().to_string().replace('/', "\\")
    );
    std::fs::write(&rc_path, rc_content).unwrap();
    match find_rc() {
        Some(rc) => match Command::new(&rc)
            .arg("/fo")
            .arg(&res_path)
            .arg(&rc_path)
            .status()
        {
            Ok(s) if s.success() => {
                println!("cargo:rustc-link-arg-bins={}", res_path.display());
            }
            other => println!(
                "cargo:warning=resource compiler failed ({:?}); building without embedded icon",
                other
            ),
        },
        None => {
            println!("cargo:warning=no resource compiler found; building without embedded icon")
        }
    }
}
