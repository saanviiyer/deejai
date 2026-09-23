"""Render the auto-positioned (section-matched) + auto-blended do you<3 mix to a
WAV in an easy-to-find place. Uses the real engine to balance/place all 15 takes,
then applies the app's auto-blend: shared reverb space, air high-shelf, and glue."""
import os, glob
import numpy as np
import soundfile as sf
import harmony as H

MEDIA = "/Users/saanviiyer/Music/GarageBand/do you<3.band/Media/Audio Files"
takes = sorted(glob.glob(os.path.join(MEDIA, "*.wav")))
assert takes, "no takes found"

out_dir = os.path.join(os.path.dirname(__file__), "blend_session")
cfg = H.BalanceConfig(beat_snap=True, tune=0.5)   # snap placements to the beat + minimal pitch correction
report = H.balance(takes, out_dir, lead=None, config=cfg)   # lead=None -> longest take is the DTW reference
sr = report.sample_rate

mix, sr = sf.read(os.path.join(out_dir, "preview_mix.wav"), always_2d=True)
print(f"positioned stack: {mix.shape[0]/sr:.1f}s, {len(report.tracks)} takes")

# the blend (matches the app's auto-blend)
L = H._reverb(H._highshelf(mix[:, 0], sr, 3.5, freq_hz=8000.0), sr, 0.28)
R = H._reverb(H._highshelf(mix[:, 1], sr, 3.5, freq_hz=8000.0), sr, 0.28)
blend = np.stack([L, R], axis=1)
peak = np.max(np.abs(blend)) + 1e-9
blend = np.tanh(blend / peak * 1.1) * 0.94
blend = blend / (np.max(np.abs(blend)) + 1e-9) * H._db_to_lin(-1.0)

for dest in [os.path.join(os.path.expanduser("~"), "Downloads", "do_you_blend.wav"),
             os.path.join(os.path.dirname(__file__), "do_you_blend.wav")]:
    sf.write(dest, blend.astype(np.float32), sr)
    print("wrote", dest, f"{os.path.getsize(dest)/1e6:.1f} MB")
