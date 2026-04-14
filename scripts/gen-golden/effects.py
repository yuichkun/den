"""Registry of reference effect implementations.

Sub D appends gain; every future effect appends here. Keep these SIMPLE,
TEXTBOOK implementations — this is the "truth" the WASM kernel is null-tested
against.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np

from signals import SR


@dataclass
class Effect:
    name: str
    process: Callable[..., np.ndarray]
    presets: dict[str, dict]


def passthrough(x: np.ndarray) -> np.ndarray:
    return x.copy()


def gain_process(
    x: np.ndarray,
    target: float,
    sr: int = SR,
    tau: float = 0.020,
    init: float = 1.0,
) -> np.ndarray:
    """Per-channel linear gain with 1-pole exponential smoothing.

    Mirrors `den_gain_process` exactly (k-rate broadcast: a single target
    held for the whole render). f64 intermediates, f32 output — matches
    the Rust kernel which is f32 throughout but cast for output (drift
    over 2 s @ 48 kHz is well under -120 dBFS for linear gain, no
    feedback / accumulation).
    """
    coef = 1.0 - np.exp(-1.0 / (sr * tau))
    smoothed = np.full(x.shape[1], init, dtype=np.float64)
    tgt = np.full(x.shape[1], target, dtype=np.float64)
    out = np.empty_like(x)
    xf = x.astype(np.float64)
    for i in range(xf.shape[0]):
        smoothed += (tgt - smoothed) * coef
        out[i] = (xf[i] * smoothed).astype(np.float32)
    return out


REGISTRY: dict[str, Effect] = {
    "passthrough": Effect(
        name="passthrough",
        process=lambda x: passthrough(x),
        presets={"default": {}},
    ),
    "gain": Effect(
        name="gain",
        process=lambda x, gain=1.0: gain_process(x, gain),
        presets={
            "unity":     {"gain": 1.0},
            "minus_6db": {"gain": 0.5011872336272722},  # 10**(-6/20)
            "plus_6db":  {"gain": 1.9952623149688795},  # 10**( 6/20)
            "silence":   {"gain": 0.0},
            "mid_fade":  {"gain": 0.25},
        },
    ),
}
