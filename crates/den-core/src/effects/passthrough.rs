//! Stereo passthrough kernel — output equals input. Used by Sub C's test
//! harness to validate the WASM build / worklet bridge / null-test wiring
//! without DSP getting in the way.

/// # Safety
///
/// * `l_in`, `r_in` must each be valid pointers to `n_samples` readable `f32`s.
/// * `l_out`, `r_out` must each be valid pointers to `n_samples` writable `f32`s.
/// * The four regions must not overlap.
/// * All four pointers must remain valid for the duration of the call.
///
/// In practice the caller is the AudioWorklet processor in
/// `@denaudio/worklet`, which allocates the four buffers via
/// [`crate::den_alloc`] at a fixed 128-sample render quantum and writes
/// the input channels into them before this call.
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
