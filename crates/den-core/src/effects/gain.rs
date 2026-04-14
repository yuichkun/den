//! Gain effect: per-channel multiply with 1-pole exponential smoothing.
//!
//! Reference: textbook (input * gain). Smoothing: `y[n] = y[n-1] + coef*(target - y[n-1])`,
//! `coef = 1 - exp(-1/(sr*tau))`, `tau = 20 ms`.
//!
//! State ([`GainState`]) must be allocated by JS (via [`den_gain_size`] +
//! [`crate::den_alloc`]) and initialized via [`den_gain_init`].
//!
//! ## Numerical precision
//!
//! Smoothing state and per-sample multiplication run in `f64` even though
//! the audio buffers are `f32` — this matches the scipy reference (also
//! `f64` throughout, `f32` output) bit-for-bit. An earlier attempt at
//! `f32` state hit the per-sample multiply noise floor at ~-91 dBFS at
//! +6 dB and forced per-preset Tier2 tolerance overrides; with `f64`
//! every preset clears -96 dBFS with margin > 30 dB. Cost is 12 bytes
//! of extra state and a 2× ALU on the smoothing math (negligible —
//! gain is the simplest effect). This is the canonical pattern Sub E's
//! template will recommend for any effect with smoothed feedback or
//! recursive coefficients.

use core::slice;

const TAU_SECONDS: f64 = 0.020;

#[repr(C)]
pub struct GainState {
    smoothed_l: f64,
    smoothed_r: f64,
    smooth_coef: f64,
}

#[unsafe(no_mangle)]
pub extern "C" fn den_gain_size() -> usize {
    core::mem::size_of::<GainState>()
}

/// # Safety
///
/// `state` must be a non-null pointer to a writable [`GainState`]
/// allocation (e.g., obtained from [`crate::den_alloc`] with at least
/// [`den_gain_size`] bytes). Pass a null pointer and the function
/// returns a no-op (release-mode safety net for the worklet's
/// allocate-then-init flow when [`crate::den_alloc`] returns null on OOM).
/// After this call the state is initialized so that the smoothed value
/// is 1.0 (unity) on both channels and the per-sample smoothing
/// coefficient matches the given sample rate.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn den_gain_init(state: *mut GainState, sample_rate: f32) {
    if state.is_null() {
        return;
    }
    let s = unsafe { &mut *state };
    s.smoothed_l = 1.0;
    s.smoothed_r = 1.0;
    // Compute the coef in f64 (libm::exp, not expf) — this is the
    // companion to the f64 smoothing state. The result naturally fits
    // f32 (~1e-3 at 48 kHz / 20 ms tau) but staying in f64 throughout
    // means scipy's reference matches us bit-for-bit on the trajectory.
    s.smooth_coef = 1.0_f64 - libm::exp(-1.0_f64 / (f64::from(sample_rate) * TAU_SECONDS));
}

/// # Safety
///
/// * `state` must be a non-null, initialized [`GainState`] pointer (see
///   [`den_gain_init`]). A null `state` triggers a no-op (release-mode
///   safety net for OOM upstream).
/// * `l_in`, `r_in` must each be valid pointers to `n` readable `f32`s.
/// * `l_out`, `r_out` must each be valid pointers to `n` writable `f32`s.
/// * `gain_values` must be a valid pointer to `n_gain_values` readable
///   `f32`s. Per the W3C Web Audio spec, the AudioParam float array passed
///   to `process()` is either length 1 (k-rate, or a-rate when no scheduled
///   events for the quantum) OR length `n` (sample-accurate a-rate); it is
///   NEVER zero in the worklet path. Worklet-side dispatch must guarantee
///   `n_gain_values >= 1`.
/// * The four audio regions and the gain region must not overlap.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn den_gain_process(
    state: *mut GainState,
    l_in: *const f32,
    r_in: *const f32,
    l_out: *mut f32,
    r_out: *mut f32,
    n: usize,
    gain_values: *const f32,
    n_gain_values: usize,
) {
    if state.is_null() {
        return;
    }
    if n == 0 {
        return;
    }

    let s = unsafe { &mut *state };
    let li = unsafe { slice::from_raw_parts(l_in, n) };
    let ri = unsafe { slice::from_raw_parts(r_in, n) };
    let lo = unsafe { slice::from_raw_parts_mut(l_out, n) };
    let ro = unsafe { slice::from_raw_parts_mut(r_out, n) };

    // SAFETY for `gvs`: avoid `from_raw_parts(null, 0)` UB. Worklet-side
    // dispatch guarantees `n_gain_values >= 1`, but we explicitly guard
    // here so that no path constructs a slice from a possibly-null pointer.
    // Use `unreachable!` (vs `debug_assert!(false, …)`) to make the dead
    // intent obvious; the surrounding `if n_gain_values == 0` keeps the
    // release build safe instead of trapping.
    let gvs: &[f32] = if n_gain_values == 0 {
        debug_assert!(
            false,
            "den_gain_process: n_gain_values must be >= 1 (k-rate=1, a-rate=n)"
        );
        &[]
    } else {
        unsafe { slice::from_raw_parts(gain_values, n_gain_values) }
    };

    let coef = s.smooth_coef;
    let a_rate = n_gain_values == n;

    if a_rate {
        for i in 0..n {
            let target = f64::from(gvs[i]);
            s.smoothed_l += (target - s.smoothed_l) * coef;
            s.smoothed_r += (target - s.smoothed_r) * coef;
            lo[i] = (f64::from(li[i]) * s.smoothed_l) as f32;
            ro[i] = (f64::from(ri[i]) * s.smoothed_r) as f32;
        }
    } else {
        // k-rate broadcast (length 1). If `n_gain_values` is unexpectedly 0
        // (debug_assert above caught it), fall back to the AudioParam default.
        let target = if gvs.is_empty() {
            1.0_f64
        } else {
            f64::from(gvs[0])
        };
        for i in 0..n {
            s.smoothed_l += (target - s.smoothed_l) * coef;
            s.smoothed_r += (target - s.smoothed_r) * coef;
            lo[i] = (f64::from(li[i]) * s.smoothed_l) as f32;
            ro[i] = (f64::from(ri[i]) * s.smoothed_r) as f32;
        }
    }
}

// --- Tier1 unit tests (host-target, not WASM) ------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use alloc::vec::Vec;

    fn alloc_state(sr: f32) -> GainState {
        let mut s = GainState {
            smoothed_l: 0.0,
            smoothed_r: 0.0,
            smooth_coef: 0.0,
        };
        unsafe { den_gain_init(&mut s as *mut _, sr) };
        s
    }

    #[test]
    fn unity_gain_is_identity_after_steady_state() {
        let mut state = alloc_state(48000.0);
        let n = 1024usize;
        let input: Vec<f32> = (0..n).map(|i| (i as f32 / n as f32).sin()).collect();
        let mut out_l = vec![0f32; n];
        let mut out_r = vec![0f32; n];
        let gain = [1.0f32]; // k-rate
        unsafe {
            den_gain_process(
                &mut state as *mut _,
                input.as_ptr(),
                input.as_ptr(),
                out_l.as_mut_ptr(),
                out_r.as_mut_ptr(),
                n,
                gain.as_ptr(),
                1,
            );
        }
        // Initial smoothed == 1.0 (init), target == 1.0; should be identity from sample 0.
        for i in 0..n {
            assert!((out_l[i] - input[i]).abs() < 1e-6, "mismatch at {i}");
        }
    }

    #[test]
    fn zero_gain_produces_silence_eventually() {
        let mut state = alloc_state(48000.0);
        let n = 48000; // 1 second
        let input = vec![0.5f32; n];
        let mut out_l = vec![0f32; n];
        let mut out_r = vec![0f32; n];
        let gain = [0.0f32];
        unsafe {
            den_gain_process(
                &mut state as *mut _,
                input.as_ptr(),
                input.as_ptr(),
                out_l.as_mut_ptr(),
                out_r.as_mut_ptr(),
                n,
                gain.as_ptr(),
                1,
            );
        }
        // After 15 tau (300 ms), residual ~exp(-15) ≈ 3e-7 ≈ -130 dBFS.
        // Assert < -100 dBFS to leave float-arithmetic headroom (200 ms / 10 tau
        // gives only -86 dBFS — too tight).
        let tail = &out_l[(48000 * 3 / 10)..]; // after 300 ms
        let peak = tail.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        let peak_db = 20.0 * libm::log10f(peak.max(1e-12));
        assert!(
            peak_db < -100.0,
            "peak {peak} ({peak_db} dB) above -100 dB tail"
        );
    }

    #[test]
    fn step_change_smooths_no_click() {
        let mut state = alloc_state(48000.0);
        let n = 128;
        let input = vec![1.0f32; n];
        let mut out_l = vec![0f32; n];
        let mut out_r = vec![0f32; n];
        // k-rate step from default 1.0 to 0.0: smoothing kicks in.
        let gain = [0.0f32];
        unsafe {
            den_gain_process(
                &mut state as *mut _,
                input.as_ptr(),
                input.as_ptr(),
                out_l.as_mut_ptr(),
                out_r.as_mut_ptr(),
                n,
                gain.as_ptr(),
                1,
            );
        }
        // Analytic prediction: smoothed[i] ≈ (1 - coef)^i for target = 0,
        // initial = 1. With coef = 1 - exp(-1/(sr*tau)) at sr=48000, tau=20 ms
        // we have coef ≈ 1.04e-3, so smoothed[127] ≈ exp(-128/(sr*tau))
        // ≈ exp(-128/960) ≈ 0.8753. Allow ±0.005 for f64 round-off.
        let mut prev = 1.0f32;
        for v in &out_l {
            assert!(*v <= prev + 1e-6, "non-monotonic at {v} vs {prev}");
            prev = *v;
        }
        let predicted = libm::exp(-128.0 / (48000.0 * TAU_SECONDS)) as f32;
        let actual = out_l[n - 1];
        assert!(
            (actual - predicted).abs() < 5e-3,
            "step decay actual {actual} vs predicted {predicted} (diff > 5e-3)"
        );
    }
}
