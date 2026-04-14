#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
mod wasm {
    extern crate alloc;

    use alloc::alloc::{Layout, alloc as a_alloc, dealloc as a_dealloc};
    use core::panic::PanicInfo;
    use dlmalloc::GlobalDlmalloc;

    #[global_allocator]
    static GLOBAL: GlobalDlmalloc = GlobalDlmalloc;

    // Panic → trap. No std::io, no format strings at runtime.
    #[panic_handler]
    fn panic(_info: &PanicInfo) -> ! {
        // `core::arch::wasm32::unreachable` is a SAFE fn (stable since Rust 1.37);
        // it emits the WebAssembly `unreachable` instruction which aborts
        // execution deterministically. No `unsafe {}` block is required — and
        // adding one would trigger `unused_unsafe` under `clippy -D warnings`.
        core::arch::wasm32::unreachable()
    }

    // --- Memory exports --------------------------------------------------
    //
    // JS calls these to get/free WASM heap regions for passing audio buffers.
    // Alignment is fixed at 16 bytes (enough for f32 and future SIMD).

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

    #[unsafe(no_mangle)]
    pub extern "C" fn den_dealloc(ptr: *mut u8, n_bytes: usize) {
        if ptr.is_null() || n_bytes == 0 {
            return;
        }
        let Ok(layout) = Layout::from_size_align(n_bytes, ALIGN) else {
            return;
        };
        unsafe { a_dealloc(ptr, layout) };
    }

    // --- Stub DSP: stereo passthrough ------------------------------------
    //
    // Signature: `den_passthrough(l_in, r_in, l_out, r_out, n_samples)`.
    // Copies input to output channel-by-channel.

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn den_passthrough(
        l_in: *const f32,
        r_in: *const f32,
        l_out: *mut f32,
        r_out: *mut f32,
        n_samples: usize,
    ) {
        let lin = unsafe { core::slice::from_raw_parts(l_in, n_samples) };
        let rin = unsafe { core::slice::from_raw_parts(r_in, n_samples) };
        let lout = unsafe { core::slice::from_raw_parts_mut(l_out, n_samples) };
        let rout = unsafe { core::slice::from_raw_parts_mut(r_out, n_samples) };
        lout.copy_from_slice(lin);
        rout.copy_from_slice(rin);
    }

    // Future: each effect kernel adds its own `den_<effect>_process(...)` export here.
}

#[cfg(not(target_arch = "wasm32"))]
pub const __HOST_BUILD_PLACEHOLDER: u32 = 0;
