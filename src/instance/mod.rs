//! One running GoLow per profile; a second launch asks the first to show itself.
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::Instance;
#[cfg(windows)]
pub use windows::{show_message, Instance};
