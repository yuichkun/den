//! Per-effect DSP kernels. Each effect lives in its own sibling file and
//! exports `den_<effect>_*` C-ABI symbols from `lib.rs` via `pub use`.

pub mod gain;
pub mod passthrough;
