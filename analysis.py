"""
deejai analysis — the producer's "ears"
=======================================

Turns audio into the structured findings an agent reads to decide what to do,
instead of firing a preset move. Also doubles as a diagnostic tool.

Key outputs per mix:
  - per-track loudness (LUFS) and peak, so the agent knows what sits where
  - spectral masking between the lead and each other track, so it knows *where*
    two parts fight (which band to carve) rather than guessing
  - clipping / harshness flags, so it can tell a degraded take from a clean one
  - a plain-language `issues` list, the perception summary the agent acts on
"""

from __future__ import annotations

import numpy as np
import soundfile as sf
import pyloudnorm as pyln

# coarse perceptual bands (Hz): where masking actually matters
BANDS = [("low", 60, 250), ("low-mid", 250, 500), ("mid", 500, 2000),
         ("high-mid", 2000, 6000), ("high", 6000, 16000)]


def _mono(path: str) -> tuple[np.ndarray, int]:
    x, sr = sf.read(path, always_2d=False)
    return (x if x.ndim == 1 else x.mean(1)).astype(np.float64), sr


def _band_energy(sig: np.ndarray, sr: int) -> dict:
    """Fraction of energy in each perceptual band."""
    mag = np.abs(np.fft.rfft(sig * np.hanning(len(sig)))) ** 2
    freqs = np.fft.rfftfreq(len(sig), 1 / sr)
    total = mag.sum() + 1e-12
    return {name: float(mag[(freqs >= lo) & (freqs < hi)].sum() / total) for name, lo, hi in BANDS}


def take_stats(path: str) -> dict:
    sig, sr = _mono(path)
    peak = float(np.max(np.abs(sig))) if sig.size else 0.0
    try:
        lufs = float(pyln.Meter(sr).integrated_loudness(sig))
    except Exception:
        lufs = float("-inf")
    clipped = int(np.sum(np.abs(sig) >= 0.999))
    bands = _band_energy(sig, sr)
    harsh = bands["high-mid"] + bands["high"]  # energy that reads as harsh/brittle
    return {
        "peak_dbfs": round(20 * np.log10(peak) if peak else -120, 1),
        "lufs": round(lufs, 1),
        "clipped_samples": clipped,
        "harshness": round(harsh, 3),
        "bands": {k: round(v, 3) for k, v in bands.items()},
    }


def _band_power(sig: np.ndarray, sr: int) -> dict:
    """Absolute power per band (not normalized), so filtering a track actually
    lowers its number instead of just reshaping the fractions."""
    mag = np.abs(np.fft.rfft(sig * np.hanning(len(sig)))) ** 2
    freqs = np.fft.rfftfreq(len(sig), 1 / sr)
    return {name: float(mag[(freqs >= lo) & (freqs < hi)].sum()) for name, lo, hi in BANDS}


def masking(lead_path: str, other_path: str) -> dict:
    """Where the two tracks actually compete in absolute level. Both band powers
    are referenced to the lead's loudest band, so carving a band on `other`
    genuinely reduces the overlap number."""
    a, sr = _mono(lead_path)
    b, _ = _mono(other_path)
    n = min(len(a), len(b))
    pa, pb = _band_power(a[:n], sr), _band_power(b[:n], sr)
    ref = max(pa.values()) + 1e-12
    overlap = {name: round(min(pa[name], pb[name]) / ref, 3) for name, _, _ in BANDS}
    worst = max(overlap, key=overlap.get)
    return {"per_band": overlap, "worst_band": worst, "worst_value": overlap[worst]}


def vocal_features(sig: np.ndarray, sr: int) -> dict:
    """Compact features the beat retrieval matches on: brightness, onset density,
    and an overall energy read. All clamped to 0..1 so scoring is stable."""
    bands = _band_energy(sig, sr)
    brightness = float(np.clip((bands["high-mid"] + bands["high"]) / 0.30, 0, 1))

    # onset density via spectral-flux peaks
    hop, win = 512, 1024
    window = np.hanning(win)
    frames = [np.abs(np.fft.rfft(sig[s:s + win] * window)) for s in range(0, len(sig) - win, hop)]
    if len(frames) < 4:
        onset_density = 0.0
    else:
        S = np.array(frames)
        flux = np.sqrt((np.clip(np.diff(S, axis=0), 0, None) ** 2).sum(axis=1))
        thr = flux.mean() + flux.std()
        peaks = np.sum((flux[1:-1] > thr) & (flux[1:-1] > flux[:-2]) & (flux[1:-1] > flux[2:]))
        dur = len(sig) / sr
        onset_density = float(peaks / dur) if dur > 0 else 0.0
    onset_norm = float(np.clip(onset_density / 3.5, 0, 1))
    energy = float(np.clip(0.6 * onset_norm + 0.4 * brightness, 0, 1))
    return {"brightness": round(brightness, 3), "onset_density": round(onset_density, 2),
            "energy": round(energy, 3)}


def diagnose(paths: list[str], label: str = "") -> None:
    """Print a quick read on a set of files (CLI diagnostic)."""
    if label:
        print(f"\n== {label} ==")
    print(f"{'file':<26}{'LUFS':>7}{'peak':>7}{'clip':>6}{'harsh':>7}")
    for p in paths:
        import os
        s = take_stats(p)
        flag = "  <- harsh" if s["harshness"] > 0.35 else ("  <- clipping" if s["clipped_samples"] > 50 else "")
        print(f"{os.path.basename(p)[:25]:<26}{s['lufs']:>7}{s['peak_dbfs']:>7}"
              f"{s['clipped_samples']:>6}{s['harshness']:>7}{flag}")


if __name__ == "__main__":
    import sys
    diagnose(sys.argv[1:], "files")
