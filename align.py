"""Content-aware take alignment for blending vocals.

The goal: overlap takes where they *should* overlap, not just at their entrances.

Two strategies, chosen per take:
  1. lyrics / content — when a take has words (its spectral content changes over
     time), find the position where its formant/energy pattern best matches the
     reference. Same words land on top of each other.
  2. harmony — when a take is a sustained vowel ("ooh", little content change),
     find the position where its pitches are most consonant with the reference.

Both return a START offset in samples (relative to the reference start): positive
means the take begins later on the timeline; negative means its lead-in is trimmed.
"""
from __future__ import annotations
import numpy as np
from numpy.fft import rfft, rfftfreq
from scipy.signal import fftconvolve
from scipy.fft import dct

_WIN = 2048
_HOP = 1024

# interval consonance for harmony scoring (index = semitone distance mod 12).
# unison/3rds/4th/5th/6th/octave reward; semitone/tritone penalize.
_CONS = np.array([1.0, -0.6, -0.1, 0.7, 0.8, 0.6, -0.5, 0.9, 0.6, 0.7, -0.1, -0.4])


def _frames(sig: np.ndarray, sr: int):
    if len(sig) < _WIN:
        sig = np.pad(sig, (0, _WIN - len(sig)))
    w = np.hanning(_WIN)
    starts = range(0, len(sig) - _WIN + 1, _HOP)
    return np.array([np.abs(rfft(sig[i:i + _WIN] * w)) for i in starts])  # (T, bins)


def content_features(sig: np.ndarray, sr: int, nbands: int = 40, ncoef: int = 13):
    """Per-frame MFCCs (L2-normalized) + activity weight. MFCCs capture the
    phoneme/formant shape independent of pitch, so the SAME lyric sung at
    different pitches still matches — what we need to overlap words."""
    F = _frames(sig, sr)
    if not len(F):
        return np.zeros((0, ncoef - 1)), np.zeros(0)
    freqs = rfftfreq(_WIN, 1 / sr)
    edges = np.logspace(np.log10(80), np.log10(min(8000, sr / 2 - 1)), nbands + 1)
    bands = np.zeros((F.shape[0], nbands))
    for b in range(nbands):
        m = (freqs >= edges[b]) & (freqs < edges[b + 1])
        if m.any():
            bands[:, b] = F[:, m].mean(1)
    logb = np.log1p(bands)
    mfcc = dct(logb, type=2, axis=1, norm="ortho")[:, 1:ncoef]   # drop c0 (loudness)
    energy = F.sum(1)
    act = energy / (energy.max() + 1e-9)
    norm = np.linalg.norm(mfcc, axis=1, keepdims=True) + 1e-9
    return mfcc / norm, act


def chroma_features(sig: np.ndarray, sr: int):
    """Per-frame 12-D chroma (pitch-class energy) + activity weight."""
    F = _frames(sig, sr)
    if not len(F):
        return np.zeros((0, 12)), np.zeros(0)
    freqs = rfftfreq(_WIN, 1 / sr)
    keep = freqs > 60
    pcs = np.mod(np.round(12 * np.log2((freqs[keep] + 1e-9) / 440.0) + 69).astype(int), 12)
    Fk = F[:, keep]
    chroma = np.zeros((F.shape[0], 12))
    for pc in range(12):
        cols = pcs == pc
        if cols.any():
            chroma[:, pc] = Fk[:, cols].sum(1)
    energy = F.sum(1)
    act = energy / (energy.max() + 1e-9)
    norm = chroma.sum(1, keepdims=True) + 1e-9
    return chroma / norm, act


def _min_overlap_mask(nr: int, nt: int, frac: float = 0.2):
    """Boolean over the full-correlation lag axis, True where the two sequences
    overlap by at least `frac` of the shorter one (kills tiny-overlap spikes)."""
    overlap = fftconvolve(np.ones(nr), np.ones(nt), mode="full")
    return overlap >= max(1.0, frac * min(nr, nt))


def _lag_axis(nr: int, nt: int):
    return np.arange(-(nt - 1), nr)   # lag>0: take starts this many frames after ref


def content_curve(ref: np.ndarray, take: np.ndarray, sr: int):
    """Activity-weighted cosine similarity between take and reference content
    (MFCC) at every lag. Returns (sim, lags, valid_mask)."""
    rf, ra = content_features(ref, sr)
    tf, ta = content_features(take, sr)
    if not len(rf) or not len(tf):
        return np.zeros(1), np.zeros(1, int), np.zeros(1, bool)
    rw, tw = rf * ra[:, None], tf * ta[:, None]
    num = np.zeros(len(ra) + len(ta) - 1)
    for b in range(rf.shape[1]):
        num += fftconvolve(rw[:, b], tw[::-1, b], mode="full")
    den = fftconvolve(ra, ta[::-1], mode="full") + 1e-6
    return num / den, _lag_axis(len(ra), len(ta)), _min_overlap_mask(len(ra), len(ta))


def harmony_curve(ref: np.ndarray, take: np.ndarray, sr: int):
    """Pitch-consonance score between take and reference at every lag (for
    sustained-vowel takes with no lyric content to match). Returns (score, lags)."""
    rc, ra = chroma_features(ref, sr)
    tc, ta = chroma_features(take, sr)
    if not len(rc) or not len(tc):
        return np.zeros(1), np.zeros(1, int)
    rw, tw = rc * ra[:, None], tc * ta[:, None]
    num = np.zeros(len(ra) + len(ta) - 1)
    for p in range(12):
        for q in range(12):
            w = _CONS[(p - q) % 12]
            if w:
                num += w * fftconvolve(rw[:, p], tw[::-1, q], mode="full")
    den = fftconvolve(ra, ta[::-1], mode="full") + 1e-6
    return num / den, _lag_axis(len(ra), len(ta))


# ---------------------------------------------------------------------------
# full section matching via subsequence DTW
# ---------------------------------------------------------------------------

def _l2(feat):
    return feat / (np.linalg.norm(feat, axis=1, keepdims=True) + 1e-9)


def _active_span(act, thresh=0.06):
    """First/last frame indices with real energy (trim leading/trailing silence)."""
    on = np.where(act > thresh)[0]
    if not len(on):
        return 0, len(act)
    return int(on[0]), int(on[-1]) + 1


def _subseq_dtw(Q, R):
    """Subsequence DTW: find where query Q best matches a contiguous stretch of
    reference R (Q, R are L2-normalized feature rows). Returns (start_frame_in_R,
    normalized_cost). Query may begin anywhere in R (free start), and steps allow
    mild tempo differences."""
    m, n = len(Q), len(R)
    if m == 0 or n == 0:
        return 0, 9.9
    C = 1.0 - Q @ R.T                      # cosine distance, (m, n)
    D = np.empty((m, n))
    D[0] = C[0]                            # free to start matching at any column
    INF = np.inf
    PEN = 0.15                             # favour the diagonal (slope ~1): penalise
    for i in range(1, m):                  # ref-stall and ref-skip so a take can't be
        prev = D[i - 1]                    # time-compressed to fake a match
        s0 = prev + PEN                    # (i-1, j)   ref stalls  -> penalise
        s1 = np.empty(n); s1[0] = INF; s1[1:] = prev[:-1]           # (i-1, j-1) diagonal
        s2 = np.empty(n); s2[:2] = INF; s2[2:] = prev[:-2] + PEN    # (i-1, j-2) ref skip -> penalise
        D[i] = C[i] + np.minimum(s0, np.minimum(s1, s2))
    b = int(np.argmin(D[-1]))
    i, j = m - 1, b                        # backtrack to the start column
    while i > 0:
        cands = [D[i - 1, j] + PEN]
        cands.append(D[i - 1, j - 1] if j >= 1 else INF)
        cands.append((D[i - 1, j - 2] + PEN) if j >= 2 else INF)
        j -= int(np.argmin(cands)); i -= 1
    return int(max(0, j)), float(D[-1, b] / m)


def section_offset(ref, take, sr, feat="mfcc", sub=4):
    """Where the take belongs in the reference, by subsequence DTW on MFCC
    (lyrics) or chroma (harmony) features. Returns (start_samples, cost); start
    can be negative (trim the take's head). No bound — this is full section match."""
    if feat == "chroma":
        rf, ra = chroma_features(ref, sr); tf, ta = chroma_features(take, sr)
    else:
        rf, ra = content_features(ref, sr); tf, ta = content_features(take, sr)
    if len(rf) < 2 or len(tf) < 2:
        return 0, 9.9
    q0, q1 = _active_span(ta)              # trim the take to its sung content
    Q = _l2(tf[q0:q1])[::sub]
    R = _l2(rf)[::sub]
    a, cost = _subseq_dtw(Q, R)            # a = ref frame (subsampled) where take content starts
    start_frames = a * sub - q0            # take frame 0 sits here in the reference
    return int(start_frames * _HOP), cost


def _pick_in_window(curve, lags, center_lag, win_frames, valid=None):
    m = np.abs(lags - center_lag) <= win_frames
    if valid is not None:
        m &= valid
    if not m.any():
        m = valid if (valid is not None and valid.any()) else np.ones(len(lags), bool)
    masked = np.where(m, curve, -1e9)
    k = int(np.argmax(masked))
    return int(lags[k]), float(curve[k])


def place_offset(ref: np.ndarray, take: np.ndarray, sr: int, onset_delta: int,
                 lyric_max: float = 0.25, harm_max: float = 0.35, any_max: float = 0.6):
    """Full section matching: find where the take belongs in the reference by
    subsequence DTW, first on lyrics (MFCC), then harmony (chroma). Falls back to
    the entrance (onset) prior only when neither matches confidently, so a take
    that doesn't line up anywhere isn't dropped at a random spot. `onset_delta` is
    (lead_onset - take_onset) in samples. Returns (start>=0, trim>=0, mode)."""
    s_lyr, c_lyr = section_offset(ref, take, sr, feat="mfcc")
    s_har, c_har = section_offset(ref, take, sr, feat="chroma")
    if c_lyr <= lyric_max:
        delta, mode = s_lyr, "lyrics"
    elif c_har <= harm_max:
        delta, mode = s_har, "harmony"
    elif min(c_lyr, c_har) <= any_max:
        delta, mode = (s_lyr, "lyrics") if c_lyr <= c_har else (s_har, "harmony")
    else:
        delta, mode = onset_delta, "onset"
    return max(0, delta), max(0, -delta), mode
