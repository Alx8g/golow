use crate::Action;
use std::{
    fs, io,
    io::Write,
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    thread,
};
use tao::event_loop::EventLoopProxy;

pub struct Instance(UnixListener, PathBuf);

impl Instance {
    /// Returns None after asking the instance that owns this profile to show itself.
    pub fn acquire(profile: &Path) -> io::Result<Option<Self>> {
        let socket = profile.join("instance.sock");
        if let Ok(mut running) = UnixStream::connect(&socket) {
            running.write_all(b"show\n")?;
            return Ok(None);
        }
        // Nothing answered, so any socket file left behind is from a crashed run.
        let _ = fs::remove_file(&socket);
        Ok(Some(Self(UnixListener::bind(&socket)?, socket)))
    }

    /// A second launch connects here; the window shows and focuses itself.
    pub fn listen(&self, proxy: EventLoopProxy<Action>) -> io::Result<()> {
        let listener = self.0.try_clone()?;
        thread::spawn(move || {
            for _ in listener.incoming().flatten() {
                let _ = proxy.send_event(Action::Show);
            }
        });
        Ok(())
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.1);
    }
}
