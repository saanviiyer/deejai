"""
deejai drum kits
================

High-quality synthesized drum one-shots, cached as real WAV files under kits/.
The beat engine sequences these one-shots (like a sampler) instead of
re-synthesizing every hit, which is why they sound less mechanical.

Each kit is a character (brightness, decay, sub weight). To use a commercial
sample pack instead, drop WAVs named kick/snare/hat_closed/hat_open/clap/rim
into kits/<name>/ and they load in place of the synthesized ones. Nothing else
changes.

Kits: pop (punchy, bright), lofi (soft, filtered, vinyl-ish), trap (long 808
sub, sharp snare), electronic (tight four-on-floor kit).
"""

from __future__ import annotations

import os

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

SR = 44100
KITS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kits")
INSTRUMENTS = ["kick", "snare", "hat_closed", "hat_open", "clap", "rim"]

# per-kit character knobs
KIT_SPECS = {
    "pop":        {"kick_f0": 130, "kick_f1": 48, "kick_decay": 14, "sub": 0.0,  "lp": 16000, "snare_tone": 190, "snare_noise": 0.7, "hat_decay": 55},
    "lofi":       {"kick_f0": 110, "kick_f1": 45, "kick_decay": 18, "sub": 0.1,  "lp": 6500,  "snare_tone": 170, "snare_noise": 0.5, "hat_decay": 70},
    "trap":       {"kick_f0": 150, "kick_f1": 38, "kick_decay": 6,  "sub": 0.55, "lp": 15000, "snare_tone": 210, "snare_noise": 0.85, "hat_decay": 80},
    "electronic": {"kick_f0": 140, "kick_f1": 50, "kick_decay": 16, "sub": 0.15, "lp": 18000, "snare_tone": 200, "snare_noise": 0.8, "hat_decay": 45},
}


def _env(n: int, decay: float) -> np.ndarray:
    t = np.linspace(0, n / SR, n, endpoint=False)
    return np.exp(-t * decay)


def _lp(x: np.ndarray, hz: float) -> np.ndarray:
    hz = min(hz, SR / 2 - 100)
    return sosfilt(butter(4, hz, btype="lowpass", fs=SR, output="sos"), x)


def _hp(x: np.ndarray, hz: float) -> np.ndarray:
    return sosfilt(butter(4, hz, btype="highpass", fs=SR, output="sos"), x)


def _norm(x: np.ndarray, peak: float = 0.92) -> np.ndarray:
    m = np.max(np.abs(x))
    return (x / m * peak).astype(np.float32) if m > 0 else x.astype(np.float32)


def _kick(s: dict) -> np.ndarray:
    dur = 0.5 if s["sub"] > 0.4 else 0.32
    n = int(SR * dur)
    t = np.linspace(0, dur, n, endpoint=False)
    # pitch sweep from f0 down to f1
    f = s["kick_f1"] + (s["kick_f0"] - s["kick_f1"]) * np.exp(-t * 34)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * _env(n, s["kick_decay"])
    sub = s["sub"] * np.sin(2 * np.pi * s["kick_f1"] * t) * _env(n, s["kick_decay"] * 0.5)
    click = np.zeros(n)
    ck = int(SR * 0.006)
    click[:ck] = np.random.default_rng(1).standard_normal(ck) * np.linspace(1, 0, ck) * 0.5
    return _norm(_lp(body + sub + click, s["lp"]))


def _snare(s: dict) -> np.ndarray:
    n = int(SR * 0.2)
    t = np.linspace(0, 0.2, n, endpoint=False)
    noise = np.random.default_rng(2).standard_normal(n) * _env(n, 22)
    noise = _hp(noise, 1200)
    tone = (np.sin(2 * np.pi * s["snare_tone"] * t) + 0.6 * np.sin(2 * np.pi * s["snare_tone"] * 1.6 * t)) * _env(n, 26)
    mix = s["snare_noise"] * noise + (1 - s["snare_noise"]) * tone
    return _norm(_lp(mix, s["lp"]))


def _hat(s: dict, decay: float) -> np.ndarray:
    dur = max(0.03, 6.0 / decay)
    n = int(SR * dur)
    noise = np.random.default_rng(3).standard_normal(n)
    # metallic: sum of high square-ish partials shaped by noise
    return _norm(_hp(noise, 7000) * _env(n, decay), 0.55)


def _clap(s: dict) -> np.ndarray:
    n = int(SR * 0.22)
    out = np.zeros(n)
    rng = np.random.default_rng(4)
    for d in (0.0, 0.008, 0.016, 0.03):  # staggered bursts
        start = int(SR * d)
        seg = rng.standard_normal(n - start) * _env(n - start, 40)
        out[start:] += seg
    return _norm(_hp(_lp(out, s["lp"]), 1000), 0.8)


def _rim(s: dict) -> np.ndarray:
    n = int(SR * 0.05)
    t = np.linspace(0, 0.05, n, endpoint=False)
    click = np.sin(2 * np.pi * 1700 * t) * _env(n, 120)
    click[:int(SR * 0.002)] += np.random.default_rng(5).standard_normal(int(SR * 0.002)) * 0.6
    return _norm(_hp(click, 800), 0.7)


_SYNTH = {"kick": _kick, "snare": _snare, "hat_closed": lambda s: _hat(s, s["hat_decay"]),
          "hat_open": lambda s: _hat(s, s["hat_decay"] * 0.35), "clap": _clap, "rim": _rim}


def build_kit(name: str) -> None:
    """Synthesize and cache a kit's one-shots to kits/<name>/*.wav."""
    spec = KIT_SPECS[name]
    d = os.path.join(KITS_DIR, name)
    os.makedirs(d, exist_ok=True)
    for inst in INSTRUMENTS:
        sf.write(os.path.join(d, f"{inst}.wav"), _SYNTH[inst](spec), SR)


def get_kit(name: str) -> dict:
    """Load a kit's one-shots (building/caching if missing). Real sample packs
    dropped into kits/<name>/ are picked up here automatically."""
    if name not in KIT_SPECS:
        name = "pop"
    d = os.path.join(KITS_DIR, name)
    if not all(os.path.exists(os.path.join(d, f"{i}.wav")) for i in INSTRUMENTS):
        build_kit(name)
    kit = {}
    for inst in INSTRUMENTS:
        x, sr = sf.read(os.path.join(d, f"{inst}.wav"), always_2d=False)
        kit[inst] = x if x.ndim == 1 else x.mean(1)
    return kit


if __name__ == "__main__":
    for k in KIT_SPECS:
        build_kit(k)
        kit = get_kit(k)
        print(f"{k:<12} " + "  ".join(f"{i}:{len(kit[i])/SR*1000:.0f}ms" for i in INSTRUMENTS))
