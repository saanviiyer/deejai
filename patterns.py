"""
deejai beat patterns + sampler
==============================

Genre-tagged 16-step (one bar of 16th notes) patterns. Each instrument is a
length-16 velocity array (0 = no hit). Patterns carry the tags the retrieval
step matches against: energy target, tempo range, and a default kit.

render_beat() sequences a kit's one-shots over these steps at the vocal tempo,
with swing, per-hit velocity/timing humanization, and a start offset so the
downbeat lands with the vocal. Output is exactly n_samples long, peak-normalized.
"""

from __future__ import annotations

import numpy as np

import drumkit as DK

# each pattern: 16-step velocity arrays per instrument + tags
PATTERNS = {
    "pop_backbeat": {
        "kit": "pop", "energy": 0.5, "brightness": 0.6, "tempo": (88, 132), "swing": 0.06,
        "kick":       [1.0, 0, 0, 0,  0, 0, 0, 0,  0.9, 0, 0.5, 0,  0, 0, 0, 0],
        "snare":      [0, 0, 0, 0,  1.0, 0, 0, 0.25,  0, 0, 0, 0,  1.0, 0, 0, 0],
        "hat_closed": [0.8, 0, 0.55, 0,  0.6, 0, 0.55, 0,  0.8, 0, 0.55, 0,  0.6, 0, 0.55, 0],
    },
    "four_on_floor": {
        "kit": "electronic", "energy": 0.85, "brightness": 0.7, "tempo": (118, 132), "swing": 0.0,
        "kick":     [1.0, 0, 0, 0,  1.0, 0, 0, 0,  1.0, 0, 0, 0,  1.0, 0, 0, 0],
        "clap":     [0, 0, 0, 0,  0.8, 0, 0, 0,  0, 0, 0, 0,  0.8, 0, 0, 0],
        "hat_open": [0, 0, 0.5, 0,  0, 0, 0.5, 0,  0, 0, 0.5, 0,  0, 0, 0.5, 0],
    },
    "boom_bap": {
        "kit": "pop", "energy": 0.55, "brightness": 0.4, "tempo": (82, 100), "swing": 0.18,
        "kick":       [1.0, 0, 0, 0,  0, 0, 0.8, 0,  0, 0, 0.5, 0,  0, 0, 0, 0],
        "snare":      [0, 0, 0, 0,  1.0, 0, 0, 0,  0, 0, 0, 0,  1.0, 0, 0.3, 0],
        "hat_closed": [0.7, 0, 0.5, 0,  0.6, 0, 0.5, 0,  0.7, 0, 0.5, 0,  0.6, 0, 0.5, 0],
    },
    "lofi_swing": {
        "kit": "lofi", "energy": 0.3, "brightness": 0.25, "tempo": (68, 92), "swing": 0.28,
        "kick":       [0.9, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0.6, 0,  0, 0, 0, 0],
        "snare":      [0, 0, 0, 0,  0.7, 0, 0, 0,  0, 0, 0, 0,  0.7, 0, 0, 0],
        "hat_closed": [0.4, 0, 0.35, 0,  0.4, 0, 0.35, 0,  0.4, 0, 0.35, 0,  0.4, 0, 0.35, 0],
    },
    "trap": {
        "kit": "trap", "energy": 0.8, "brightness": 0.75, "tempo": (128, 160), "swing": 0.0,
        "kick":       [1.0, 0, 0, 0,  0, 0, 0.7, 0,  0, 0, 0.7, 0.4,  0, 0, 0, 0],
        "clap":       [0, 0, 0, 0,  0, 0, 0, 0,  1.0, 0, 0, 0,  0, 0, 0, 0],
        "hat_closed": [0.6, 0.4, 0.5, 0.4,  0.6, 0.4, 0.5, 0.55,  0.6, 0.4, 0.5, 0.4,  0.6, 0.5, 0.55, 0.6],
    },
    "ballad": {
        "kit": "pop", "energy": 0.25, "brightness": 0.35, "tempo": (58, 84), "swing": 0.1,
        "kick":       [1.0, 0, 0, 0,  0, 0, 0, 0,  0.8, 0, 0, 0,  0, 0, 0, 0],
        "rim":        [0, 0, 0, 0,  0.5, 0, 0, 0,  0, 0, 0, 0,  0.5, 0, 0, 0],
        "hat_closed": [0.35, 0, 0, 0,  0, 0, 0, 0,  0.35, 0, 0, 0,  0, 0, 0, 0],
    },
}


def choose_beat(features: dict, bpm: float) -> tuple[str, dict]:
    """Retrieve the best-fitting pattern for a vocal from its features + tempo.
    Deterministic argmax over energy, brightness, and tempo-range fit."""
    best_name, best_score, best_why = "pop_backbeat", -1e9, {}
    for name, p in PATTERNS.items():
        lo, hi = p["tempo"]
        tempo_fit = 1.0 if lo <= bpm <= hi else max(0.0, 1 - min(abs(bpm - lo), abs(bpm - hi)) / 40.0)
        e = 1 - abs(p["energy"] - features["energy"])
        b = 1 - abs(p["brightness"] - features["brightness"])
        score = 0.42 * e + 0.33 * b + 0.25 * tempo_fit
        if score > best_score:
            best_score, best_name = score, name
            best_why = {"energy_fit": round(e, 2), "brightness_fit": round(b, 2),
                        "tempo_fit": round(tempo_fit, 2), "score": round(score, 3)}
    return best_name, best_why

_STEP_INSTS = ("kick", "snare", "hat_closed", "hat_open", "clap", "rim")


def render_beat(pattern_name: str, bpm: float, n_samples: int, sr: int,
                kit_name: str | None = None, start: int = 0, peak: float = 0.5,
                swing: float | None = None) -> np.ndarray:
    """Sequence a kit's one-shots over a pattern, humanized, exactly n_samples long."""
    pat = PATTERNS.get(pattern_name, PATTERNS["pop_backbeat"])
    kit = DK.get_kit(kit_name or pat["kit"])
    sw = pat["swing"] if swing is None else swing
    step = sr * 60.0 / bpm / 4.0                 # samples per 16th
    if step < 1:
        return np.zeros(n_samples, dtype=np.float64)
    rng = np.random.default_rng(7)

    tail = max(len(kit[i]) for i in _STEP_INSTS)
    out = np.zeros(n_samples + tail)

    def place(sample: np.ndarray, at: int, vel: float) -> None:
        at = max(0, at + int(rng.normal(0, sr * 0.003)))   # ~3 ms human jitter
        end = min(at + len(sample), len(out))
        if end > at:
            out[at:end] += sample[:end - at] * vel * rng.uniform(0.9, 1.0)

    # grid passes through `start` (the vocal downbeat): step index 0 sits at `start`,
    # so downbeats line up with the vocal. Fills [0, n_samples), including before start.
    j = -int(np.ceil(start / step)) if start > 0 else 0
    while True:
        base = start + j * step
        if base >= n_samples:
            break
        if base >= 0:
            local = j % 16                                       # periodic; j=0 is the downbeat
            swung = base + (step * sw if local % 2 == 1 else 0.0)
            for inst in _STEP_INSTS:
                arr = pat.get(inst)
                if arr and arr[local] > 0:
                    place(kit[inst], int(round(swung)), arr[local])
        j += 1

    out = out[:n_samples]
    m = np.max(np.abs(out))
    return out / m * peak if m > 0 else out


if __name__ == "__main__":
    import analysis  # noqa
    for name in PATTERNS:
        b = render_beat(name, 120, 44100 * 4, 44100)
        print(f"{name:<15} len={len(b)} peak={np.max(np.abs(b)):.3f} rms={np.sqrt((b**2).mean()):.4f}")
