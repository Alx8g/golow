use std::{env, fs, path::PathBuf};

const APP_NAME: &str = "GoLow";

fn main() {
    println!("cargo:rerun-if-changed=assets/icon.ico");
    println!("cargo:rerun-if-changed=assets/icon.png");
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    // Decode once at build time, not during every application launch.
    let decoded = image::open(manifest.join("assets/icon.png")).expect("valid app icon").to_rgba8();
    let (width, height) = decoded.dimensions();
    fs::write(out.join("icon.rgba"), decoded.as_raw()).expect("write decoded icon");
    println!("cargo:rustc-env=APP_ICON_WIDTH={width}");
    println!("cargo:rustc-env=APP_ICON_HEIGHT={height}");
    println!("cargo:rustc-env=APP_NAME={APP_NAME}");

    // The page script: src/page/*.js joined in name order inside one function scope.
    println!("cargo:rerun-if-changed=src/page");
    let mut parts: Vec<PathBuf> = fs::read_dir(manifest.join("src/page"))
        .expect("src/page")
        .filter_map(|entry| Some(entry.ok()?.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "js"))
        .collect();
    parts.sort();
    let mut script = String::from("(() => {\n");
    for part in &parts {
        script += &fs::read_to_string(part).expect("read page script");
        script.push('\n');
    }
    script += "})();\n";
    fs::write(out.join("client.js"), script).expect("write page script");

    let icon = manifest.join("assets").join("icon.ico");
    let version = env::var("CARGO_PKG_VERSION").unwrap();
    let exe = format!("{}.exe", env::var("CARGO_PKG_NAME").unwrap());
    let numeric_version = format!("{},0", version.replace('.', ","));
    let rc = format!(
        "1 ICON \"{}\"\n\
         1 VERSIONINFO\n\
         FILEVERSION {numeric_version}\n\
         PRODUCTVERSION {numeric_version}\n\
         BEGIN\n\
         \u{20} BLOCK \"StringFileInfo\"\n\
         \u{20} BEGIN\n\
         \u{20}\u{20} BLOCK \"040904E4\"\n\
         \u{20}\u{20} BEGIN\n\
         \u{20}\u{20}\u{20} VALUE \"FileDescription\", \"{APP_NAME}\"\n\
         \u{20}\u{20}\u{20} VALUE \"ProductName\", \"{APP_NAME}\"\n\
         \u{20}\u{20}\u{20} VALUE \"FileVersion\", \"{version}\"\n\
         \u{20}\u{20}\u{20} VALUE \"ProductVersion\", \"{version}\"\n\
         \u{20}\u{20}\u{20} VALUE \"OriginalFilename\", \"{exe}\"\n\
         \u{20}\u{20} END\n\
         \u{20} END\n\
         \u{20} BLOCK \"VarFileInfo\"\n\
         \u{20} BEGIN\n\
         \u{20}\u{20} VALUE \"Translation\", 0x409, 1252\n\
         \u{20} END\n\
         END\n",
        // RC string literals treat a single backslash as an escape.
        icon.display().to_string().replace(['/', '\\'], "\\\\")
    );
    let rc_path = out.join("app.rc");
    // Rewriting an unchanged file would make Cargo rerun this script on every build.
    if fs::read_to_string(&rc_path).ok().as_deref() != Some(rc.as_str()) {
        fs::write(&rc_path, rc).expect("write resource script");
    }
    // The installer reads the embedded version, so a build without it is not shippable.
    // embed-resource finds rc.exe through the Windows SDK, without a developer prompt.
    embed_resource::compile(&rc_path, embed_resource::NONE)
        .manifest_required()
        .unwrap_or_else(|error| panic!("embedding the icon and version resource failed: {error}"));
}
