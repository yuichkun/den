#![no_std]

extern crate alloc;

use dlmalloc::GlobalDlmalloc;

// Issue #3 §8 Fallback #4: `alloc` crate requires a `#[global_allocator]` in
// `no_std`. `dlmalloc` is the allocator family the issue names as the allowed
// shim, kept in lockstep with the parent-epic decision D3 ("default Rust
// allocator, dlmalloc-derived").
#[global_allocator]
static GLOBAL: GlobalDlmalloc = GlobalDlmalloc;

// Panic → trap. No std::io, no format strings at runtime.
//
// Gated on `cfg(not(test))` because Tier1 `cargo test` compiles the lib
// alongside the std-backed test framework, which already provides a
// `#[panic_handler]` — defining ours under test would conflict. On the
// wasm32 cdylib build (Sub B's actual artifact) we trap via the wasm
// `unreachable` instruction; on a host cdylib build (used by cargo's
// non-test `cargo build`) we fall through to an infinite loop, which
// satisfies the `-> !` contract without needing platform abort APIs.
#[cfg(not(test))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    #[cfg(target_arch = "wasm32")]
    {
        // SAFE fn (stable since Rust 1.37); emits the WebAssembly
        // `unreachable` instruction. No `unsafe {}` block is required —
        // adding one would trigger `unused_unsafe` under `clippy -D warnings`.
        core::arch::wasm32::unreachable()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        loop {}
    }
}

pub mod alloc_shim;
pub mod effects;

// Re-export every WASM-side symbol so the cdylib build emits them. JS
// resolves these from the WASM module's exports table.
pub use alloc_shim::*;
pub use effects::gain::*;
pub use effects::passthrough::*;
