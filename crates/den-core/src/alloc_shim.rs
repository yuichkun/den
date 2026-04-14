//! WASM heap allocation shim called from the AudioWorklet processor.
//!
//! Sub D moved this out of `lib.rs` so each effect can live in its own
//! `effects/<name>.rs` and the crate root can stay free of DSP code.
//!
//! JS calls these to get/free WASM heap regions for passing audio buffers
//! and effect state. Alignment is fixed at 16 bytes (enough for f32 and
//! future SIMD lanes).

use alloc::alloc::{Layout, alloc as a_alloc, dealloc as a_dealloc};

const ALIGN: usize = 16;

#[unsafe(no_mangle)]
pub extern "C" fn den_alloc(n_bytes: usize) -> *mut u8 {
    if n_bytes == 0 {
        return core::ptr::null_mut();
    }
    let Ok(layout) = Layout::from_size_align(n_bytes, ALIGN) else {
        return core::ptr::null_mut();
    };
    unsafe { a_alloc(layout) }
}

/// # Safety
///
/// `ptr` must be either null, or a pointer returned by a prior call to
/// [`den_alloc`] with the *same* `n_bytes` and 16-byte alignment that
/// is still live (not already freed). After this call, `ptr` is invalid.
///
/// Marked `unsafe` to mirror the contract of `alloc::alloc::dealloc` itself
/// (and to keep the raw-pointer ABI exports in `den-core` consistent with
/// the kernel exports in `effects/`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn den_dealloc(ptr: *mut u8, n_bytes: usize) {
    if ptr.is_null() || n_bytes == 0 {
        return;
    }
    let Ok(layout) = Layout::from_size_align(n_bytes, ALIGN) else {
        return;
    };
    unsafe { a_dealloc(ptr, layout) };
}
