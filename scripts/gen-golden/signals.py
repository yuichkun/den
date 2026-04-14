"""Canonical test signals shared by every effect's golden generation."""
from __future__ import annotations

import numpy as np
from scipy.signal import chirp, lfilter

SR = 48000
DUR = 2.0
N = int(SR * DUR)


def chirp_log() -> np.ndarray:
    """Log chirp 20 -> 20000 Hz over 2 s, stereo coherent, -3 dBFS peak."""
    t = np.linspace(0, DUR, N, endpoint=False)
    s = chirp(t, f0=20, f1=20000, t1=DUR, method="logarithmic") * 10 ** (-3 / 20)
    return np.stack([s, s], axis=1).astype(np.float32)


def pink_noise() -> np.ndarray:
    # Paul Kellet's pink noise IIR filter (3-pole approximation of 1/f).
    # Source: https://www.firstpr.com.au/dsp/pink-noise/ (Kellet's optimized
    # coefficients, NOT the Voss-McCartney summed-octaves algorithm).
    # Deterministic seed.
    rng = np.random.default_rng(42)
    white = rng.standard_normal(N)
    b = np.array([0.04957526213, 0.06305581334, 0.01483220320], dtype=np.float64)
    a = np.array([1.0, -1.80116083982, 0.80257737639], dtype=np.float64)
    s = lfilter(b, a, white).astype(np.float32) * 10 ** (-12 / 20)
    return np.stack([s, s], axis=1)


def sine(freq: float, dur: float = 0.5) -> np.ndarray:
    n = int(SR * dur)
    t = np.linspace(0, dur, n, endpoint=False)
    s = np.sin(2 * np.pi * freq * t) * 10 ** (-6 / 20)
    return np.stack([s, s], axis=1).astype(np.float32)


def impulse() -> np.ndarray:
    s = np.zeros(N, dtype=np.float32)
    s[0] = 1.0
    return np.stack([s, s], axis=1)


def dc(level: float = 0.5) -> np.ndarray:
    s = np.full(N, level, dtype=np.float32)
    return np.stack([s, s], axis=1)


def silence() -> np.ndarray:
    s = np.zeros(N, dtype=np.float32)
    return np.stack([s, s], axis=1)


CANONICAL = {
    "chirp": chirp_log,
    "pink": pink_noise,
    "sine_1k": lambda: sine(1000.0, 1.0),
    "sine_5k": lambda: sine(5000.0, 1.0),
    "sine_10k": lambda: sine(10000.0, 1.0),
    "impulse": impulse,
    "dc_half": lambda: dc(0.5),
    "silence": silence,
}
