//! Previous, play/pause and next buttons under the taskbar thumbnail, like other music players.
//! The icons are drawn here, so the app ships no image files for them.
use windows::{
    core::Result,
    Win32::{
        Foundation::HWND,
        Graphics::Gdi::{CreateBitmap, DeleteObject},
        System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
        UI::{
            Shell::{
                ITaskbarList3, TaskbarList, THBF_ENABLED, THB_FLAGS, THB_ICON, THB_TOOLTIP,
                THUMBBUTTON,
            },
            WindowsAndMessaging::{
                CreateIconIndirect, DestroyIcon, GetSystemMetrics, HICON, ICONINFO, SM_CXSMICON,
            },
        },
    },
};

pub const PREVIOUS: u32 = 1;
pub const PLAY: u32 = 2;
pub const NEXT: u32 = 3;

/// Shapes in a unit square: triangles and rectangles that form each glyph.
enum Shape {
    Triangle([(f32, f32); 3]),
    Rect(f32, f32, f32, f32),
}

fn glyph(shapes: &[Shape], size: usize) -> Vec<u8> {
    let inside = |x: f32, y: f32| {
        shapes.iter().any(|shape| match shape {
            Shape::Rect(left, top, right, bottom) => {
                (*left..=*right).contains(&x) && (*top..=*bottom).contains(&y)
            }
            Shape::Triangle([a, b, c]) => {
                let edge = |p: (f32, f32), q: (f32, f32)| {
                    (q.0 - p.0) * (y - p.1) - (q.1 - p.1) * (x - p.0)
                };
                let (d1, d2, d3) = (edge(*a, *b), edge(*b, *c), edge(*c, *a));
                (d1 >= 0.0 && d2 >= 0.0 && d3 >= 0.0) || (d1 <= 0.0 && d2 <= 0.0 && d3 <= 0.0)
            }
        })
    };
    // 4x4 supersampling for smooth edges; white with alpha, in BGRA order.
    let mut pixels = vec![0u8; size * size * 4];
    for py in 0..size {
        for px in 0..size {
            let mut covered = 0;
            for sy in 0..4 {
                for sx in 0..4 {
                    let x = (px as f32 + (sx as f32 + 0.5) / 4.0) / size as f32;
                    let y = (py as f32 + (sy as f32 + 0.5) / 4.0) / size as f32;
                    covered += u32::from(inside(x, y));
                }
            }
            let alpha = (covered * 255 / 16) as u8;
            pixels[(py * size + px) * 4..][..4].copy_from_slice(&[alpha, alpha, alpha, alpha]);
        }
    }
    pixels
}

fn icon(shapes: &[Shape], size: usize) -> Result<HICON> {
    let pixels = glyph(shapes, size);
    let mask = vec![0u8; size.div_ceil(16) * 2 * size];
    unsafe {
        let color = CreateBitmap(size as i32, size as i32, 1, 32, Some(pixels.as_ptr().cast()));
        let mask = CreateBitmap(size as i32, size as i32, 1, 1, Some(mask.as_ptr().cast()));
        let info = ICONINFO {
            fIcon: true.into(),
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask,
            hbmColor: color,
        };
        let icon = CreateIconIndirect(&info);
        let _ = DeleteObject(color.into());
        let _ = DeleteObject(mask.into());
        icon
    }
}

pub struct Taskbar {
    list: ITaskbarList3,
    window: HWND,
    icons: [HICON; 4],
    playing: bool,
}

impl Taskbar {
    /// Call after Windows announces the taskbar button (the TaskbarButtonCreated message).
    pub fn add(window: isize, playing: bool) -> Result<Self> {
        let size = unsafe { GetSystemMetrics(SM_CXSMICON) }.clamp(16, 64) as usize;
        let previous = [
            Shape::Rect(0.2, 0.22, 0.3, 0.78),
            Shape::Triangle([(0.78, 0.22), (0.78, 0.78), (0.32, 0.5)]),
        ];
        let next = [
            Shape::Rect(0.7, 0.22, 0.8, 0.78),
            Shape::Triangle([(0.22, 0.22), (0.22, 0.78), (0.68, 0.5)]),
        ];
        let play = [Shape::Triangle([(0.3, 0.2), (0.3, 0.8), (0.8, 0.5)])];
        let pause = [Shape::Rect(0.26, 0.22, 0.42, 0.78), Shape::Rect(0.58, 0.22, 0.74, 0.78)];
        let icons =
            [icon(&previous, size)?, icon(&play, size)?, icon(&pause, size)?, icon(&next, size)?];
        let list: ITaskbarList3 =
            unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)? };
        let taskbar = Self { list, window: HWND(window as _), icons, playing };
        unsafe {
            taskbar.list.HrInit()?;
            taskbar.list.ThumbBarAddButtons(taskbar.window, &taskbar.buttons())?;
        }
        Ok(taskbar)
    }

    fn buttons(&self) -> [THUMBBUTTON; 3] {
        let button = |id: u32, icon: HICON, tip: &str| {
            let mut tooltip = [0u16; 260];
            for (slot, unit) in tooltip.iter_mut().zip(tip.encode_utf16()) {
                *slot = unit;
            }
            THUMBBUTTON {
                dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
                iId: id,
                hIcon: icon,
                szTip: tooltip,
                dwFlags: THBF_ENABLED,
                ..Default::default()
            }
        };
        let (play_icon, play_tip) =
            if self.playing { (self.icons[2], "Pause") } else { (self.icons[1], "Play") };
        [
            button(PREVIOUS, self.icons[0], "Previous"),
            button(PLAY, play_icon, play_tip),
            button(NEXT, self.icons[3], "Next"),
        ]
    }

    pub fn set_playing(&mut self, playing: bool) {
        if playing != self.playing {
            self.playing = playing;
            let _ = unsafe { self.list.ThumbBarUpdateButtons(self.window, &self.buttons()) };
        }
    }
}

impl Drop for Taskbar {
    fn drop(&mut self) {
        for icon in self.icons {
            let _ = unsafe { DestroyIcon(icon) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glyphs_cover_their_shape_with_soft_edges() {
        let pixels = glyph(&[Shape::Rect(0.2, 0.2, 0.8, 0.8)], 16);
        let alpha = |x: usize, y: usize| pixels[(y * 16 + x) * 4 + 3];
        assert_eq!(alpha(8, 8), 255);
        assert_eq!(alpha(1, 1), 0);
        assert!(pixels.chunks(4).any(|p| p[3] > 0 && p[3] < 255), "anti-aliased edge");
    }
}
