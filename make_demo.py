"""
Synthesize three rough vocal-ish takes to exercise the balancer:

  lead   - the melody note, recorded loud
  third  - a harmony a major third up, recorded quiet and a hair late
  fifth  - a harmony a fifth up, recorded loud with low-end rumble

These are voiced tones (fundamental plus a few harmonics plus vibrato and a
soft noise floor), not real singing, but they give the loudness matching,
timing alignment, and high-pass stages something to actually correct.
"""

import os
import numpy as np
import soundfile as sf

SR = 44100
DUR = 4.0


def _voice(freq: float, sr: int, dur: float, rumble: float = 0.0) -> np.ndarray:
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    vibrato = 1.0 + 0.005 * np.sin(2 * np.pi * 5.0 * t)  # 5 Hz vibrato
    f = freq * vibrato
    phase = 2 * np.pi * np.cumsum(f) / sr
    # fundamental plus decaying harmonics = a vaguely voiced timbre
    sig = np.sin(phase) + 0.35 * np.sin(2 * phase) + 0.15 * np.sin(3 * phase)
    # simple fade in/out so nothing clicks
    env = np.ones_like(t)
    fade = int(sr * 0.05)
    env[:fade] = np.linspace(0, 1, fade)
    env[-fade:] = np.linspace(1, 0, fade)
    sig *= env
    sig += 0.002 * np.random.randn(len(sig))  # noise floor
    if rumble:
        sig += rumble * np.sin(2 * np.pi * 60.0 * t)  # low-end junk to be filtered
    return sig / np.max(np.abs(sig)) * 0.9


def main(out="demo_takes"):
    os.makedirs(out, exist_ok=True)
    root = 220.0  # A3

    lead = _voice(root, SR, DUR) * 0.9              # loud
    third = _voice(root * 2 ** (4 / 12), SR, DUR) * 0.25  # quiet major third
    fifth = _voice(root * 2 ** (7 / 12), SR, DUR, rumble=0.2) * 0.8  # fifth with rumble

    # push the third ~40 ms late so alignment has something to pull back
    late = int(SR * 0.040)
    third = np.concatenate([np.zeros(late), third])[: len(lead)]

    sf.write(os.path.join(out, "lead.wav"), lead.astype(np.float32), SR)
    sf.write(os.path.join(out, "harmony_third.wav"), third.astype(np.float32), SR)
    sf.write(os.path.join(out, "harmony_fifth.wav"), fifth.astype(np.float32), SR)
    print(f"wrote lead.wav, harmony_third.wav, harmony_fifth.wav to {out}/")


if __name__ == "__main__":
    main()
