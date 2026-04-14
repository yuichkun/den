"""Generate golden reference WAVs for each effect.

Usage:
  uv run --project scripts/gen-golden scripts/gen-golden/gen.py [effect...]

No effect args = all. Writes to packages/test-utils/golden/<effect>/<preset>__<signal>.wav.
"""
from __future__ import annotations

import sys
from pathlib import Path

import soundfile as sf

from signals import CANONICAL, SR
from effects import REGISTRY

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packages" / "test-utils" / "golden"


def main(argv: list[str]) -> int:
    targets = argv[1:] if len(argv) > 1 else list(REGISTRY.keys())
    for name in targets:
        impl = REGISTRY.get(name)
        if not impl:
            print(f"unknown effect: {name}", file=sys.stderr)
            return 2
        effect_dir = OUT / name
        effect_dir.mkdir(parents=True, exist_ok=True)
        for preset_name, preset_args in impl.presets.items():
            for sig_name, sig_fn in CANONICAL.items():
                x = sig_fn()
                y = impl.process(x, **preset_args)
                out = effect_dir / f"{preset_name}__{sig_name}.wav"
                sf.write(out, y, SR, subtype="FLOAT")
                print(f"  wrote {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
