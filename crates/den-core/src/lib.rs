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
// Gated on `cfg(not(test))` because Tier1 `cargo test --lib` compiles the
// lib alongside the std-backed test framework, which already provides a
// `#[panic_handler]` — defining ours under test would conflict. (Doctests
// are disabled via `[lib] doctest = false` in Cargo.toml so plain
// `cargo test -p den-core` doesn't trip on them either.)
//
// On the wasm32 cdylib build (Sub B's actual ship target) we trap via the
// wasm `unreachable` instruction. On a non-wasm host build the fallback
// is `loop {}`; this is enough for `cargo check` and the wasm-release
// profile, but a plain `cargo build -p den-core` on host (debug) still
// fails to link because liballoc's debug profile pulls in
// `_rust_eh_personality`. We accept that trade — the host build target
// here is the test binary, not the cdylib. If you ever need a host
// cdylib, build with `--release` or add a `#[no_mangle] extern "C" fn
// rust_eh_personality()` shim.
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

// Re-export the C-ABI symbols so the cdylib build emits them. JS resolves
// these from the WASM module's exports table. We list them explicitly
// (rather than glob-re-exporting) to keep the public Rust surface
// minimal — `GainState` and friends stay accessible as
// `effects::gain::GainState` for any future Rust consumer that needs them.
pub use alloc_shim::{den_alloc, den_dealloc};
pub use effects::gain::{den_gain_init, den_gain_process, den_gain_size};
pub use effects::passthrough::den_passthrough;
