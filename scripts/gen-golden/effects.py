"""Registry of reference effect implementations.

Sub D appends gain; every future effect appends here. Keep these SIMPLE,
TEXTBOOK implementations — this is the "truth" the WASM kernel is null-tested
against.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np


@dataclass
class Effect:
    name: str
    process: Callable[..., np.ndarray]
    presets: dict[str, dict]


def passthrough(x: np.ndarray) -> np.ndarray:
    return x.copy()


REGISTRY: dict[str, Effect] = {
    "passthrough": Effect(
        name="passthrough",
        process=lambda x: passthrough(x),
        presets={"default": {}},
    ),
    # Sub D adds "gain" here.
}
