"""
deejai harmony balancer
=======================

Takes several raw vocal takes (one lead plus one or more harmony parts) and
does the balancing pass a producer would do by hand so the parts blend:

  1. timing alignment   - shift each harmony so it lines up with the lead
  2. loudness matching   - measure LUFS, set the lead on top, harmonies under it
  3. masking-aware EQ    - high-pass the harmonies so they stop muddying the low end
  4. stereo placement    - keep the lead centered, spread the harmonies L/R

It writes one processed stem per input (level + EQ + timing already applied,
mono, ready to drag into GarageBand) plus a summed stereo preview_mix.wav so you
can hear the result immediately, and a report.json describing every decision.

Nothing here touches GarageBand. You export your takes as WAV, run this, and
drag the processed stems back in. The recommended pan for each stem is in the
report if you want to set it by hand in GarageBand instead of using the baked
preview.
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass, asdict, field

import numpy as np
import soundfile as sf
import pyloudnorm as pyln
from scipy.signal import butter, sosfilt, correlate, fftconvolve


# ---------------------------------------------------------------------------
# small dsp helpers
# ---------------------------------------------------------------------------

def _to_mono(x: np.ndarray) -> np.ndarray:
    """Collapse to a single channel. Vocal takes are mono in practice, but a
    take exported as interleaved stereo should still work."""
    if x.ndim == 1:
        return x.astype(np.float64)
    return x.mean(axis=1).astype(np.float64)


def _highpass(x: np.ndarray, sr: int, cutoff_hz: float, order: int = 4) -> np.ndarray:
    """Zero-ish-phase high-pass to clear low-end buildup without dulling the take."""
    if cutoff_hz <= 0:
        return x
    sos = butter(order, cutoff_hz, btype="highpass", fs=sr, output="sos")
    return sosfilt(sos, x)


def _highshelf(x: np.ndarray, sr: int, gain_db: float, freq_hz: float = 6000.0) -> np.ndarray:
    """RBJ high-shelf. Positive gain adds air/brightness, negative darkens.
    Used for plain-language 'brighter' / 'warmer' requests."""
    if abs(gain_db) < 0.01:
        return x
    A = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * freq_hz / sr
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / 2.0 * np.sqrt(2.0)  # Q = 0.707
    two_sqrtA_alpha = 2.0 * np.sqrt(A) * alpha
    b0 = A * ((A + 1) + (A - 1) * cw + two_sqrtA_alpha)
    b1 = -2 * A * ((A - 1) + (A + 1) * cw)
    b2 = A * ((A + 1) + (A - 1) * cw - two_sqrtA_alpha)
    a0 = (A + 1) - (A - 1) * cw + two_sqrtA_alpha
    a1 = 2 * ((A - 1) - (A + 1) * cw)
    a2 = (A + 1) - (A - 1) * cw - two_sqrtA_alpha
    from scipy.signal import lfilter
    return lfilter([b0 / a0, b1 / a0, b2 / a0], [1.0, a1 / a0, a2 / a0], x)


def _reverb(x: np.ndarray, sr: int, wet: float, decay_s: float = 1.1) -> np.ndarray:
    """Cheap synthetic-room reverb: convolve with a decaying, slightly delayed
    noise tail and mix wet against dry. `wet` is 0..1. Adds space/depth."""
    if wet <= 0:
        return x
    n = int(sr * decay_s)
    t = np.arange(n) / sr
    # a short pre-delay gap, then exponentially decaying diffuse noise
    predelay = int(sr * 0.02)
    ir = np.zeros(n)
    tail = np.random.default_rng(0).standard_normal(n - predelay) * np.exp(-t[:n - predelay] * 4.0)
    ir[predelay:] = tail
    ir /= (np.sqrt(np.sum(ir ** 2)) + 1e-9)  # unit energy so wet level is predictable
    wet_sig = fftconvolve(x, ir, mode="full")[: len(x)]
    return (1.0 - wet) * x + wet * wet_sig


def detect_tempo(sig: np.ndarray, sr: int, min_bpm: float = 70.0, max_bpm: float = 160.0) -> float:
    """Estimate BPM from a signal's onset envelope by autocorrelation. Vocals
    have soft onsets, so this is an estimate, not ground truth - the beat feature
    lets the user override it with an explicit BPM."""
    hop, win = 512, 1024
    window = np.hanning(win)
    frames = [np.abs(np.fft.rfft(sig[s:s + win] * window))
              for s in range(0, len(sig) - win, hop)]
    if len(frames) < 4:
        return 120.0
    S = np.array(frames)
    flux = np.sqrt((np.clip(np.diff(S, axis=0), 0, None) ** 2).sum(axis=1))
    flux = np.clip(flux - flux.mean(), 0, None)
    ac = np.correlate(flux, flux, mode="full")[len(flux) - 1:]
    fps = sr / hop
    lo, hi = int(fps * 60 / max_bpm), int(fps * 60 / min_bpm)
    seg = ac[lo:hi + 1]
    if not len(seg):
        return 120.0
    lag = lo + int(np.argmax(seg))
    return float(60.0 * fps / max(lag, 1))


def _kick(sr: int, dur: float = 0.18) -> np.ndarray:
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    freq = 110.0 * np.exp(-t * 30.0) + 45.0          # pitch drops into the floor
    return np.sin(2 * np.pi * np.cumsum(freq) / sr) * np.exp(-t * 18.0)


def _snare(sr: int, dur: float = 0.14) -> np.ndarray:
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    noise = np.random.default_rng(1).standard_normal(len(t))
    return (0.7 * noise + 0.3 * np.sin(2 * np.pi * 180 * t)) * np.exp(-t * 22.0)


def _hat(sr: int, dur: float = 0.05) -> np.ndarray:
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    noise = np.random.default_rng(2).standard_normal(len(t))
    sos = butter(2, 6000, btype="highpass", fs=sr, output="sos")
    return sosfilt(sos, noise) * np.exp(-t * 60.0) * 0.5


def detect_downbeat(sig: np.ndarray, sr: int) -> int:
    """Sample offset of the first strong onset, so the beat lands with the vocal
    instead of at t=0."""
    win = max(1, int(sr * 0.01))
    env = fftconvolve(np.abs(sig), np.ones(win) / win, mode="same")
    thresh = env.max() * 0.35
    hits = np.where(env > thresh)[0]
    return int(hits[0]) if len(hits) else 0


def make_beat(bpm: float, n_samples: int, sr: int, peak: float = 0.5,
              swing: float = 0.12, start: int = 0) -> np.ndarray:
    """A humanized 4/4 loop: kick on 1 and 3, snare on 2 and 4 with ghost snares,
    hats on swung eighths with accents, and small timing/velocity jitter so no two
    bars are identical. `swing` delays the off-beat eighth; `start` aligns the
    downbeat to the vocal."""
    step = int(sr * 60.0 / bpm)
    kick, snare, hat = _kick(sr), _snare(sr), _hat(sr)
    out = np.zeros(n_samples + step + max(len(kick), len(snare), len(hat)))
    rng = np.random.default_rng(7)

    def place(sample: np.ndarray, at: int, vel: float) -> None:
        at = max(0, at + int(rng.normal(0, sr * 0.004)))  # ~4 ms human jitter
        end = min(at + len(sample), len(out))
        if end > at:
            out[at:end] += sample[:end - at] * vel

    pos, beat = start, 0
    swing_off = int(step * 0.5 * (1 + swing))  # pushed-back off-beat
    while pos < n_samples:
        b = beat % 4
        if b in (0, 2):
            place(kick, pos, 1.0 if b == 0 else 0.85)
        else:
            place(snare, pos, 1.0)
            if rng.random() < 0.4:                       # occasional ghost snare
                place(snare, pos + int(step * 0.75), 0.25)
        place(hat, pos, 0.9 if b == 0 else 0.6)          # accented downbeat hat
        place(hat, pos + swing_off, 0.45)                # swung off-beat hat
        pos += step
        beat += 1
    out = out[start:start + n_samples] if start else out[:n_samples]
    m = np.max(np.abs(out))
    return out / m * peak if m > 0 else out


# ---------------------------------------------------------------------------
# harmonic backing: detect the vocal's key, then synth pad / bass / arp over a
# chord progression in that key, locked to the vocal tempo
# ---------------------------------------------------------------------------

PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]  # natural minor
# Krumhansl-Kessler key profiles, used to score which key the vocal sits in
_MAJ_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MIN_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# progressions as diatonic scale degrees (0 = the tonic chord)
PROGRESSIONS = {
    "pop": [0, 4, 5, 3],     # I  V  vi IV
    "sad": [5, 3, 0, 4],     # vi IV I  V
    "50s": [0, 5, 3, 4],     # I  vi IV V
    "ballad": [0, 3, 4, 3],  # I  IV V  IV
}


def _chroma(sig: np.ndarray, sr: int) -> np.ndarray:
    """12-bin pitch-class energy, summed across the take."""
    hop, win = 2048, 4096
    window = np.hanning(win)
    freqs = np.fft.rfftfreq(win, 1 / sr)
    ratio = np.where(freqs > 20, freqs / 440.0, 1.0)  # keep log2 finite below 20 Hz
    pc = np.where(freqs > 20, (np.round(12 * np.log2(ratio) + 69).astype(int)) % 12, -1)
    chroma = np.zeros(12)
    for s in range(0, len(sig) - win, hop):
        mag = np.abs(np.fft.rfft(sig[s:s + win] * window))
        for k in range(12):
            chroma[k] += mag[pc == k].sum()
    return chroma


def detect_key(sig: np.ndarray, sr: int) -> tuple[int, str]:
    """Best (tonic pitch-class, 'major'/'minor') for the take, by correlating its
    chroma against rotated key profiles."""
    chroma = _chroma(sig, sr)
    if chroma.sum() == 0:
        return 0, "major"
    best, choice = -2.0, (0, "major")
    for tonic in range(12):
        for mode, profile in (("major", _MAJ_PROFILE), ("minor", _MIN_PROFILE)):
            r = float(np.corrcoef(chroma, np.roll(profile, tonic))[0, 1])
            if r > best:
                best, choice = r, (tonic, mode)
    return choice


def _midi_to_freq(m: float) -> float:
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def _osc(freq: float, n: int, sr: int, kind: str = "saw") -> np.ndarray:
    t = np.arange(n) / sr
    if kind == "sine":
        return np.sin(2 * np.pi * freq * t)
    out = sum(np.sin(2 * np.pi * freq * h * t) / h for h in range(1, 6))  # soft saw
    return out / 1.7


def _adsr(n: int, sr: int, a: float, r: float) -> np.ndarray:
    env = np.ones(n)
    if n <= 0:
        return env
    ai, ri = min(int(a * sr), n), min(int(r * sr), n)   # a very short note can't fit a full attack/release
    if ai > 0:
        env[:ai] = np.linspace(0, 1, ai)
    if ri > 0:
        env[-ri:] *= np.linspace(1, 0, ri)
    return env


def _lowpass(x: np.ndarray, sr: int, hz: float) -> np.ndarray:
    return sosfilt(butter(4, hz, btype="lowpass", fs=sr, output="sos"), x)


def _norm(x: np.ndarray, peak: float) -> np.ndarray:
    m = np.max(np.abs(x))
    return x / m * peak if m > 0 else x


def build_chord_seq(tonic: int, mode: str, progression: str, bpm: float,
                    total: int, sr: int, bars_per_chord: int = 1) -> list:
    """List of (midi-note chord, duration-in-samples) filling `total` samples."""
    scale = _MAJOR_SCALE if mode == "major" else _MINOR_SCALE
    base = 48 + tonic  # around C3
    twooct = [base + iv + 12 * o for o in (0, 1) for iv in scale]
    degrees = PROGRESSIONS.get(progression, PROGRESSIONS["pop"])
    chord_len = int(sr * 60.0 / bpm * 4 * bars_per_chord)  # 4 beats per bar
    seq, pos, i = [], 0, 0
    while pos < total:
        d = degrees[i % len(degrees)]
        chord = [twooct[d], twooct[d + 2], twooct[d + 4]]
        dur = min(chord_len, total - pos)
        seq.append((chord, dur))
        pos += chord_len
        i += 1
    return seq


def synth_pad(seq: list, sr: int, peak: float) -> np.ndarray:
    parts = []
    for notes, dur in seq:
        seg = np.zeros(dur)
        for m in notes:
            f = _midi_to_freq(m)
            seg += _osc(f, dur, sr, "saw") + 0.5 * _osc(f * 1.006, dur, sr, "saw")  # detuned
        seg *= _adsr(dur, sr, a=0.08, r=0.25) / len(notes)
        parts.append(seg)
    return _norm(_lowpass(np.concatenate(parts), sr, 2400), peak)


def synth_bass(seq: list, bpm: float, sr: int, peak: float) -> np.ndarray:
    step = int(sr * 60.0 / bpm)  # one note per beat on the chord root
    parts = []
    for notes, dur in seq:
        f = _midi_to_freq(min(notes) - 12)
        seg, pos = np.zeros(dur), 0
        while pos < dur:
            L = min(step, dur - pos)
            seg[pos:pos + L] += (_osc(f, L, sr, "sine") * _adsr(L, sr, 0.005, 0.06))[:L]
            pos += step
        parts.append(seg)
    return _norm(np.concatenate(parts), peak)


def synth_arp(seq: list, bpm: float, sr: int, peak: float) -> np.ndarray:
    step = int(sr * 60.0 / bpm / 2)  # eighth notes climbing the chord
    parts = []
    for notes, dur in seq:
        order = notes + notes[-2:0:-1]
        seg, pos, i = np.zeros(dur), 0, 0
        while pos < dur:
            L = min(step, dur - pos)
            f = _midi_to_freq(order[i % len(order)] + 12)
            seg[pos:pos + L] += (_osc(f, L, sr, "sine") * _adsr(L, sr, 0.003, 0.05))[:L]
            pos += step
            i += 1
        parts.append(seg)
    return _norm(np.concatenate(parts), peak)


def _peak_dbfs(x: np.ndarray) -> float:
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    return -np.inf if peak == 0 else 20.0 * np.log10(peak)


def _db_to_lin(db: float) -> float:
    return float(10.0 ** (db / 20.0))


def _align_offset(reference: np.ndarray, take: np.ndarray, sr: int,
                  max_shift_ms: float = 120.0) -> int:
    """Sample offset that best aligns `take` to `reference` via cross-correlation
    of the energy envelopes. Positive means the take lags the reference and
    should be moved earlier. Bounded to +/- max_shift_ms so a bad correlation
    can't throw a take across the timeline."""
    # envelope = smoothed absolute signal, robust to phase differences between
    # a lead and a harmony singing different notes
    def envelope(sig: np.ndarray) -> np.ndarray:
        win = max(1, int(sr * 0.005))  # 5 ms smoothing
        env = np.abs(sig)
        kernel = np.ones(win) / win
        return fftconvolve(env, kernel, mode="same")

    ref_env = envelope(reference)
    take_env = envelope(take)
    n = min(len(ref_env), len(take_env))
    ref_env, take_env = ref_env[:n], take_env[:n]

    corr = correlate(ref_env, take_env, mode="full")
    lags = np.arange(-n + 1, n)
    max_shift = int(sr * max_shift_ms / 1000.0)
    keep = np.abs(lags) <= max_shift
    corr, lags = corr[keep], lags[keep]
    if not len(corr):
        return 0
    return int(lags[int(np.argmax(corr))])


def _shift(x: np.ndarray, offset: int) -> np.ndarray:
    """Shift by integer samples, zero-padding. offset>0 moves audio earlier.
    Offsets at or beyond the length just clear the buffer (no out-of-bounds)."""
    out = np.zeros_like(x)
    if abs(offset) >= len(x):
        return out
    if offset > 0:
        out[:len(x) - offset] = x[offset:]
    elif offset < 0:
        out[-offset:] = x[:len(x) + offset]
    else:
        out[:] = x
    return out


def _f0_track(x: np.ndarray, sr: int, hop: int = 256, win: int = 1024,
             fmin: float = 80.0, fmax: float = 500.0):
    """Per-frame pitch (Hz) via FFT autocorrelation; 0 where unvoiced."""
    minP, maxP = int(sr / fmax), int(sr / fmin)
    if len(x) < win + hop:
        return np.zeros(0), hop
    idx = np.arange(0, len(x) - win, hop)
    frames = np.lib.stride_tricks.sliding_window_view(x, win)[idx] * np.hanning(win)
    nfft = 1
    while nfft < 2 * win:
        nfft <<= 1
    S = np.fft.rfft(frames, nfft, axis=1)
    ac = np.fft.irfft(S * np.conj(S), nfft, axis=1)[:, :maxP + 2]
    seg = ac[:, minP:maxP + 1] / (ac[:, 0:1] + 1e-9)
    k = np.argmax(seg, axis=1)
    conf = seg[np.arange(len(seg)), k]
    lag = k + minP
    return np.where(conf > 0.5, sr / np.maximum(lag, 1), 0.0), hop


def _autotune(x: np.ndarray, sr: int, strength: float, floor_cents: float = 20.0) -> np.ndarray:
    """Minimal TD-PSOLA pitch correction: nudge each pitch period toward the
    nearest semitone, but only for notes more than `floor_cents` off, and only by
    `strength` (0..1). Duration is preserved. Gentle by design."""
    if strength <= 0:
        return x
    f0, hop = _f0_track(x, sr)
    if not len(f0):
        return x
    N = len(x)
    defaultP = int(sr / 160)
    f0_at = lambda pos: f0[min(len(f0) - 1, max(0, int(round(pos / hop))))]
    # analysis pitch marks
    marks, pos = [], 0
    while pos < N:
        marks.append(pos)
        ff = f0_at(pos)
        pos += int(round(sr / ff)) if ff > 0 else defaultP
    out, norm = np.zeros(N), np.zeros(N)
    s, ki, guard = 0, 0, 0
    while s < N and guard < 4 * N:
        guard += 1
        while ki + 1 < len(marks) and abs(marks[ki + 1] - s) < abs(marks[ki] - s):
            ki += 1
        a = marks[ki]
        ff = f0_at(a)
        inP = int(round(sr / ff)) if ff > 0 else defaultP
        outP = inP
        if ff > 0:
            midi = round(69 + 12 * np.log2(ff / 440.0))
            tf = 440.0 * 2 ** ((midi - 69) / 12.0)
            if abs(1200 * np.log2(tf / ff)) > floor_cents:
                ratio = tf / ff
                outP = max(20, int(round(inP / (1 + (ratio - 1) * strength))))
        half = inP
        w = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(2 * half) / (2 * half - 1))
        s0, d0 = a - half, s - half
        sl, dl = max(0, s0), max(0, d0)
        length = min(N - sl, N - dl, 2 * half - (sl - s0), 2 * half - (dl - d0))
        if length > 0:
            wi = w[(sl - s0):(sl - s0) + length]
            out[dl:dl + length] += x[sl:sl + length] * wi
            norm[dl:dl + length] += wi
        s += outP
    nz = norm > 1e-3
    out[nz] /= norm[nz]
    peak = np.max(np.abs(out)) + 1e-9
    return out / peak if peak > 1 else out


def _place_offset(reference: np.ndarray, take: np.ndarray, sr: int) -> int:
    """Best START position (samples, >=0) for `take` so it lines up with
    `reference` anywhere along the timeline. Cross-correlates energy envelopes
    over the whole overlap, so a take sung for a later section lands where it
    belongs instead of being forced to the start. 0 means it starts with the lead."""
    def envelope(sig: np.ndarray) -> np.ndarray:
        win = max(1, int(sr * 0.02))  # 20 ms smoothing
        return fftconvolve(np.abs(sig), np.ones(win) / win, mode="same")

    r, t = envelope(reference), envelope(take)
    if not len(r) or not len(t):
        return 0
    r = r / (np.max(r) + 1e-9)        # normalize so a loud take doesn't always win
    t = t / (np.max(t) + 1e-9)
    corr = correlate(r, t, mode="full")
    lags = np.arange(-len(t) + 1, len(r))
    best = int(lags[int(np.argmax(corr))])
    return max(0, best)


def _equal_power_pan(mono: np.ndarray, pan: float) -> np.ndarray:
    """Place a mono signal in the stereo field. pan in [-1, 1], -1 hard left."""
    pan = float(np.clip(pan, -1.0, 1.0))
    angle = (pan + 1.0) * 0.25 * np.pi  # 0..pi/2
    left = np.cos(angle) * mono
    right = np.sin(angle) * mono
    return np.stack([left, right], axis=1)


# ---------------------------------------------------------------------------
# config + result records
# ---------------------------------------------------------------------------

@dataclass
class BalanceConfig:
    lead_lufs: float = -16.0        # target integrated loudness for the lead
    harmony_lufs_offset: float = -4.0  # harmonies sit this many LU below the lead
    lead_hpf_hz: float = 80.0       # gentle rumble cut on the lead
    harmony_hpf_hz: float = 140.0   # firmer cut so harmonies stop competing low
    harmony_pan_spread: float = 0.7  # widest pan for the outermost harmony
    align: bool = False              # legacy ±120ms cross-correlation nudge
    align_onsets: bool = True        # line up each take's first onset (fixes big offsets)
    auto_place: bool = True          # position each take where it best fits the timeline (supersedes align_onsets)
    smart_place: bool = True         # refine placement by matching lyrics (content) / harmony around the onset prior
    beat_snap: bool = False          # after placing, snap each take's start to the tempo grid (on the beat)
    beat_snap_div: float = 1.0       # grid resolution in beats (1 = quarter, 0.5 = eighth, 4 = bar)
    tune: float = 0.0                # gentle pitch correction strength (0 = off, ~0.5 = minimal)
    tune_floor_cents: float = 20.0   # only correct notes more than this far off-pitch
    grid_ref: "str | None" = None    # basename of a track whose tempo+downbeat set the beat grid (e.g. a guitar)
    grid_phase_s: "float | None" = None  # manual downbeat position (seconds); overrides detection when set
    preview_peak_dbfs: float = -1.0  # headroom on the summed preview mix


@dataclass
class BeatConfig:
    """A drum bed under the vocals, locked to the vocal tempo (not GarageBand's).
    bpm=None detects it from the lead. style=None retrieves the best-fitting
    pattern from the vocal's features; set it (e.g. 'trap', 'lofi_swing') to force
    one. kit=None uses the pattern's default kit. engine 'sampled' sequences real
    drum one-shots; 'simple' is the legacy synthesized beat."""
    enabled: bool = False
    bpm: float | None = None
    style: str | None = None
    kit: str | None = None
    engine: str = "sampled"
    gain_peak: float = 0.5   # beat peak before it's summed under the vocals


@dataclass
class BackingConfig:
    """Harmonic backing synthesized in the vocal's own key and tempo: a synth
    pad on the chords, a bassline on the roots, and/or an arpeggio."""
    pad: bool = False
    bass: bool = False
    arp: bool = False
    progression: str = "pop"
    key: tuple | None = None   # (tonic_pc, mode) override; None = detect from the lead
    bars_per_chord: int = 1
    gain_peak: float = 0.3

    def any_on(self) -> bool:
        return self.pad or self.bass or self.arp


@dataclass
class TrackAdjust:
    """Per-track overrides the producer layer stacks on top of the automatic
    balance. All default to no-ops, so an empty TrackAdjust changes nothing."""
    gain_trim_db: float = 0.0        # + louder / - quieter, on top of auto level
    pan: float | None = None         # override the automatic pan when set
    bright_db: float = 0.0           # high-shelf gain, + brighter / - warmer
    reverb_wet: float = 0.0          # 0..1 space
    extra_hpf_hz: float = 0.0        # raise the low cut further ('less muddy')


@dataclass
class TrackReport:
    name: str
    role: str
    measured_lufs: float
    applied_gain_db: float
    hpf_hz: float
    align_offset_samples: int
    align_offset_ms: float
    start_ms: float
    trim_ms: float
    pan: float
    bright_db: float
    reverb_wet: float
    out_stem: str


@dataclass
class BalanceReport:
    sample_rate: int
    lead: str
    tracks: list = field(default_factory=list)
    preview_mix: str = ""
    beat_bpm: float | None = None
    beat_style: str | None = None
    key: str | None = None
    progression: str | None = None
    notes: list = field(default_factory=list)


# ---------------------------------------------------------------------------
# engine
# ---------------------------------------------------------------------------

def balance(input_paths: list[str], out_dir: str, lead: str | None = None,
            config: BalanceConfig | None = None,
            adjustments: dict[str, "TrackAdjust"] | None = None,
            beat: "BeatConfig | None" = None,
            backing: "BackingConfig | None" = None) -> BalanceReport:
    cfg = config or BalanceConfig()
    adjustments = adjustments or {}
    if len(input_paths) < 2:
        raise ValueError("need at least two takes: one lead and one harmony")

    os.makedirs(out_dir, exist_ok=True)
    stems_dir = os.path.join(out_dir, "stems")
    os.makedirs(stems_dir, exist_ok=True)

    # load everything, force a common sample rate
    loaded: dict[str, np.ndarray] = {}
    srs: set[int] = set()
    for p in input_paths:
        data, sr = sf.read(p, always_2d=False)
        loaded[p] = _to_mono(data)
        srs.add(sr)
    if len(srs) != 1:
        raise ValueError(
            f"takes have mismatched sample rates {sorted(srs)}; export them all "
            "at the same rate (44100 or 48000) and retry"
        )
    sr = srs.pop()

    # pick the lead. with no explicit choice, the longest take is the best guide
    # to align the others into (subsequence DTW matches shorter takes into it).
    if lead is None:
        lead_path = max(input_paths, key=lambda p: len(loaded[p]))
    else:
        matches = [p for p in input_paths if os.path.basename(p) == lead or p == lead]
        if not matches:
            raise ValueError(f"lead '{lead}' not found among inputs")
        lead_path = matches[0]
    harmony_paths = [p for p in input_paths if p != lead_path]

    meter = pyln.Meter(sr)
    report = BalanceReport(sample_rate=sr, lead=os.path.basename(lead_path))

    lead_sig = loaded[lead_path]

    # even pan positions across the harmonies: for 2 -> [-spread, +spread],
    # for 3 -> [-spread, 0, +spread], and so on
    n_harm = len(harmony_paths)
    if n_harm == 1:
        pans = [0.0]  # a single harmony sits with the lead unless widened later
    else:
        pans = list(np.linspace(-cfg.harmony_pan_spread, cfg.harmony_pan_spread, n_harm))

    lead_onset = detect_downbeat(lead_sig, sr)  # reference entrance for the legacy onset-align path
    # timing grid: a chosen reference track (e.g. a guitar) defines tempo + downbeat;
    # otherwise fall back to the lead vocal. the reference itself sits at 0, untouched.
    grid_matches = [p for p in input_paths if os.path.basename(p) == cfg.grid_ref] if cfg.grid_ref else []
    grid_path = grid_matches[0] if grid_matches else None
    grid_sig = loaded[grid_path] if grid_path else lead_sig
    snap_bpm = detect_tempo(grid_sig, sr) if cfg.beat_snap else 0.0
    if cfg.grid_phase_s is not None and cfg.grid_phase_s >= 0:
        grid_phase = int(cfg.grid_phase_s * sr)          # user clicked "the 1 is here"
    else:
        grid_phase = detect_downbeat(grid_sig, sr) if grid_path else lead_onset

    def process(path: str, role: str, pan: float) -> tuple[np.ndarray, TrackReport, int]:
        adj = adjustments.get(os.path.basename(path), TrackAdjust())
        sig = loaded[path]
        offset = 0        # legacy in-place timing nudge (samples)
        start = 0         # timeline START position for this take (samples, >=0)
        trim = 0          # samples skipped at the head of the take (>=0)
        is_grid = (path == grid_path)   # the timing reference sits at 0, unmoved and untuned
        if role == "harmony" and cfg.auto_place and is_grid:
            start, trim = 0, 0
        elif role == "harmony" and cfg.auto_place:
            # position each take by its own entrance: a take that comes in later
            # than the lead is pushed later on the timeline; one whose content
            # starts earlier has its lead-in trimmed. entrances line up, starts vary.
            delta = lead_onset - detect_downbeat(sig, sr)
            if cfg.smart_place:
                # refine: overlap where the SAME LYRICS line up (content match), or
                # where the harmony is strongest (consonance) for wordless takes,
                # bounded near the entrance so it can't drift to an absurd spot.
                try:
                    import align
                    start, trim, mode = align.place_offset(lead_sig, sig, sr, delta)
                    report.notes.append(f"{os.path.basename(path)}: placed by {mode} at {start / sr:.2f}s")
                except Exception as e:
                    start, trim = max(0, delta), max(0, -delta)
                    report.notes.append(f"{os.path.basename(path)}: onset-placed (refine skipped: {e})")
            else:
                start = max(0, delta)
                trim = max(0, -delta)
        elif role == "harmony" and cfg.align_onsets:
            # shift so this take's first onset lands on the lead's (fixes an early/late entrance)
            offset = detect_downbeat(sig, sr) - lead_onset
            if abs(offset) > int(sr * 0.03):  # ignore sub-30ms jitter
                sig = _shift(sig, offset)
            else:
                offset = 0
        elif role == "harmony" and cfg.align:
            offset = _align_offset(lead_sig, sig, sr)
            sig = _shift(sig, offset)

        if role == "harmony" and cfg.auto_place and cfg.beat_snap and snap_bpm > 30 and not is_grid:
            beat_samp = sr * 60.0 / snap_bpm * cfg.beat_snap_div   # quantize onto the reference's beat grid
            start = int(max(0, round(grid_phase + round((start - grid_phase) / beat_samp) * beat_samp)))
            report.notes.append(f"{os.path.basename(path)}: beat-snapped to {start / sr:.2f}s")

        if cfg.tune > 0 and not is_grid:   # minimal pitch correction where a note is off (not the guitar)
            sig = _autotune(sig, sr, cfg.tune, cfg.tune_floor_cents)

        hpf = (cfg.lead_hpf_hz if role == "lead" else cfg.harmony_hpf_hz)
        hpf = max(hpf, adj.extra_hpf_hz)  # 'less muddy' raises the low cut
        sig = _highpass(sig, sr, hpf)

        # tone before leveling so the shelf doesn't change measured loudness much
        sig = _highshelf(sig, sr, adj.bright_db)

        try:
            measured = float(meter.integrated_loudness(sig))
        except Exception:
            measured = -np.inf
        target = cfg.lead_lufs if role == "lead" else cfg.lead_lufs + cfg.harmony_lufs_offset
        if np.isfinite(measured):
            gain_db = target - measured
        else:
            gain_db = 0.0
            report.notes.append(f"{os.path.basename(path)}: too quiet/short to measure loudness, left as-is")
        gain_db += adj.gain_trim_db  # plain-language 'louder'/'quieter' trim
        sig = sig * _db_to_lin(gain_db)

        # space last, wet tail sits on top of the leveled signal
        sig = _reverb(sig, sr, adj.reverb_wet)

        final_pan = pan if adj.pan is None else adj.pan
        stem_name = f"{role}_{os.path.splitext(os.path.basename(path))[0]}.wav"
        stem_path = os.path.join(stems_dir, stem_name)
        sf.write(stem_path, sig.astype(np.float32), sr)

        tr = TrackReport(
            name=os.path.basename(path), role=role, measured_lufs=round(measured, 2),
            applied_gain_db=round(gain_db, 2), hpf_hz=hpf,
            align_offset_samples=offset, align_offset_ms=round(offset / sr * 1000.0, 2),
            start_ms=round(start / sr * 1000.0, 2), trim_ms=round(trim / sr * 1000.0, 2),
            pan=round(final_pan, 3), bright_db=round(adj.bright_db, 2),
            reverb_wet=round(adj.reverb_wet, 2), out_stem=os.path.join("stems", stem_name),
        )
        return _equal_power_pan(sig, final_pan), tr, start, trim

    # lead first, centered at the start
    placed: list[tuple[np.ndarray, int]] = []   # (stereo segment, start_sample)
    lead_stereo, lead_tr, _, _ = process(lead_path, "lead", 0.0)
    report.tracks.append(asdict(lead_tr))
    placed.append((lead_stereo, 0))

    for path, pan in zip(harmony_paths, pans):
        st, tr, start, trim = process(path, "harmony", pan)
        report.tracks.append(asdict(tr))
        placed.append((st[trim:], start))   # skip trimmed lead-in, drop at its start

    # sum into a preview mix, each take dropped at its own position, then peak-limit
    length = max(start + seg.shape[0] for seg, start in placed)
    mix = np.zeros((length, 2), dtype=np.float64)
    for seg, start in placed:
        mix[start:start + seg.shape[0]] += seg

    # optional simple beat, locked to the detected vocal tempo
    if beat and beat.enabled:
        bpm = beat.bpm or detect_tempo(lead_sig, sr)
        start = detect_downbeat(lead_sig, sr)
        if beat.engine == "simple":
            b = make_beat(bpm, length, sr, peak=beat.gain_peak, start=start)
            style = "simple"
        else:
            import analysis
            import patterns
            feats = analysis.vocal_features(lead_sig, sr)
            style = beat.style or patterns.choose_beat(feats, bpm)[0]
            b = patterns.render_beat(style, bpm, length, sr, kit_name=beat.kit,
                                     start=start, peak=beat.gain_peak)
        mix[:len(b), 0] += b
        mix[:len(b), 1] += b
        sf.write(os.path.join(stems_dir, "beat.wav"), b.astype(np.float32), sr)
        report.beat_bpm = round(bpm, 1)
        report.beat_style = style
        report.notes.append(f"added a {style} beat at ~{round(bpm)} BPM (fit to the vocal, not GarageBand)")

    # optional harmonic backing, in the vocal's own key and tempo
    if backing and backing.any_on():
        bpm = (beat.bpm if beat and beat.bpm else None) or detect_tempo(lead_sig, sr)
        tonic, mode = backing.key or detect_key(lead_sig, sr)
        seq = build_chord_seq(tonic, mode, backing.progression, bpm, length, sr, backing.bars_per_chord)
        made = []
        if backing.pad:
            p = synth_pad(seq, sr, backing.gain_peak)
            sf.write(os.path.join(stems_dir, "synth_pad.wav"), p.astype(np.float32), sr)
            made.append(("pad", p))
        if backing.bass:
            b = synth_bass(seq, bpm, sr, backing.gain_peak * 0.9)
            sf.write(os.path.join(stems_dir, "bass.wav"), b.astype(np.float32), sr)
            made.append(("bass", b))
        if backing.arp:
            a = synth_arp(seq, bpm, sr, backing.gain_peak * 0.6)
            sf.write(os.path.join(stems_dir, "arp.wav"), a.astype(np.float32), sr)
            made.append(("arp", a))
        for _, e in made:
            mix[:len(e), 0] += e
            mix[:len(e), 1] += e
        report.key = f"{PC_NAMES[tonic]} {mode}"
        report.progression = backing.progression
        report.notes.append(
            f"added {'/'.join(n for n, _ in made)} in {report.key}, {backing.progression} progression")

    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    ceiling = _db_to_lin(cfg.preview_peak_dbfs)
    if peak > ceiling and peak > 0:
        mix *= ceiling / peak
        report.notes.append(
            f"preview mix summed past the ceiling, pulled down {round(20*np.log10(ceiling/peak),2)} dB"
        )

    preview_path = os.path.join(out_dir, "preview_mix.wav")
    sf.write(preview_path, mix.astype(np.float32), sr)
    report.preview_mix = "preview_mix.wav"

    with open(os.path.join(out_dir, "report.json"), "w") as f:
        json.dump(asdict(report), f, indent=2)

    return report


def _print_report(report: BalanceReport, out_dir: str) -> None:
    print(f"\nbalanced {len(report.tracks)} takes @ {report.sample_rate} Hz  (lead: {report.lead})\n")
    header = f"{'take':<28} {'role':<8} {'LUFS':>7} {'gain':>7} {'HPF':>6} {'align':>8} {'pan':>6}"
    print(header)
    print("-" * len(header))
    for t in report.tracks:
        print(f"{t['name'][:27]:<28} {t['role']:<8} {t['measured_lufs']:>7} "
              f"{t['applied_gain_db']:>6}d {int(t['hpf_hz']):>5}H {t['align_offset_ms']:>6}ms "
              f"{t['pan']:>6}")
    for note in report.notes:
        print(f"  note: {note}")
    print(f"\n  stems  -> {os.path.join(out_dir, 'stems')}/  (drag these into GarageBand)")
    print(f"  preview-> {os.path.join(out_dir, report.preview_mix)}")
    print(f"  report -> {os.path.join(out_dir, 'report.json')}\n")


def main() -> None:
    ap = argparse.ArgumentParser(description="Balance vocal takes into a blended harmony stack.")
    ap.add_argument("inputs", nargs="+", help="WAV takes (first is the lead unless --lead is given)")
    ap.add_argument("-o", "--out", default="deejai_out", help="output directory")
    ap.add_argument("--lead", help="filename of the lead take")
    ap.add_argument("--lead-lufs", type=float, default=-16.0, help="target loudness for the lead")
    ap.add_argument("--harmony-offset", type=float, default=-4.0, help="LU the harmonies sit below the lead")
    ap.add_argument("--spread", type=float, default=0.7, help="stereo spread of the harmonies, 0..1")
    ap.add_argument("--no-align", action="store_true", help="skip timing alignment")
    args = ap.parse_args()

    cfg = BalanceConfig(
        lead_lufs=args.lead_lufs,
        harmony_lufs_offset=args.harmony_offset,
        harmony_pan_spread=args.spread,
        align=not args.no_align,
    )
    report = balance(args.inputs, args.out, lead=args.lead, config=cfg)
    _print_report(report, args.out)


if __name__ == "__main__":
    main()
