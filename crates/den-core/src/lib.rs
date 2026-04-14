#![cfg_attr(not(test), no_std)]

// Sub B will replace this with WASM exports and a worklet-appropriate panic path.
// This stub exists so `cargo check` passes on the scaffold.

#[cfg(not(test))]
use core::panic::PanicInfo;

#[cfg(not(test))]
#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}

#[allow(dead_code)]
pub(crate) const __SCAFFOLD_SENTINEL: u32 = 0xDEADBEEF;
