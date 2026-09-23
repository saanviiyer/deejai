"""
deejai validation suite
=======================

End-to-end checks over the whole system. Run:

    python3 tests.py

Prints PASS/FAIL per section and exits non-zero if anything fails, so it doubles
as a regression gate. No network needed (the LLM path is exercised through its
offline translator, not a live Claude call).
"""

from __future__ import annotations

import os
import sys
import tempfile

import numpy as np
import soundfile as sf

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
TMP = tempfile.mkdtemp(prefix="deejai_tests_")
DEMO = [os.path.join(ROOT, "doyou_takes", f) for f in ("mid.wav", "low.wav", "super high.wav")]

_fail = []


def check(name, fn):
    try:
        fn()
        print(f"  PASS  {name}")
    except Exception as e:
        print(f"  FAIL  {name}: {e}")
        _fail.append(name)


def section(title):
    print(f"\n[{title}]")


# --------------------------------------------------------------------------
section("drum kits")
import drumkit as DK


def t_kits():
    for k in DK.KIT_SPECS:
        kit = DK.get_kit(k)
        assert set(kit) >= set(DK.INSTRUMENTS)
        for inst, x in kit.items():
            assert x.size > 10 and np.all(np.isfinite(x))
            assert 0.1 < np.max(np.abs(x)) <= 1.0001, f"{k}/{inst} level {np.max(np.abs(x))}"
check("all kits synth, finite, normalized, audible", t_kits)


# --------------------------------------------------------------------------
section("patterns + sampler")
import patterns as PAT


def t_render():
    for name in PAT.PATTERNS:
        for bpm in (68, 110, 155):
            n = int(44100 * 4)
            b = PAT.render_beat(name, bpm, n, 44100)
            assert len(b) == n, f"{name}@{bpm} length"
            assert np.all(np.isfinite(b)), f"{name}@{bpm} NaN"
            assert np.max(np.abs(b)) <= 0.5001, f"{name}@{bpm} peak"
            assert np.sqrt((b ** 2).mean()) > 1e-4, f"{name}@{bpm} silent"
check("every pattern renders exact-length, finite, normalized, audible", t_render)


def t_tempo():
    sr = 44100
    b = PAT.render_beat("four_on_floor", 120, sr * 4, sr)
    env = np.abs(b)
    ac = np.correlate(env, env, "full")[len(env) - 1:]
    lo, hi = int(sr * 0.3), int(sr * 0.7)
    lag = lo + int(np.argmax(ac[lo:hi]))
    assert abs(lag / sr - 0.5) < 0.06, f"beat period {lag/sr:.3f}s"
check("rendered tempo matches requested BPM", t_tempo)


def t_align():
    sr = 44100
    start = int(sr * 2.0)
    b = PAT.render_beat("pop_backbeat", 120, sr * 6, sr, start=start)
    assert np.max(np.abs(b[start - 500:start + 2000])) > 0.2, "no downbeat at start"
check("downbeat aligns to the start offset", t_align)


# --------------------------------------------------------------------------
section("retrieval")


def t_retrieval():
    cases = [
        ({"energy": 0.15, "brightness": 0.1}, 75, "lofi_swing"),
        ({"energy": 0.85, "brightness": 0.8}, 128, "four_on_floor"),
        ({"energy": 0.9, "brightness": 0.75}, 145, "trap"),
        ({"energy": 0.2, "brightness": 0.3}, 68, "ballad"),
    ]
    for feats, bpm, expect in cases:
        a, _ = PAT.choose_beat(feats, bpm)
        b, _ = PAT.choose_beat(feats, bpm)
        assert a == b, "nondeterministic"
        assert a in PAT.PATTERNS
        assert a == expect, f"{feats}@{bpm} -> {a}, expected {expect}"
check("retrieval is deterministic and picks sensible styles", t_retrieval)


# --------------------------------------------------------------------------
section("analysis (ears)")
import analysis as AN


def t_features():
    x, sr = sf.read(DEMO[0], always_2d=False)
    f = AN.vocal_features(x if x.ndim == 1 else x.mean(1), sr)
    for k in ("energy", "brightness", "onset_density"):
        assert k in f
    assert 0 <= f["energy"] <= 1 and 0 <= f["brightness"] <= 1
check("vocal_features returns clamped values", t_features)


def t_masking_direction():
    # carving low-mid on a track must lower its measured masking vs the lead
    x, sr = sf.read(DEMO[0], always_2d=False); lead = x if x.ndim == 1 else x.mean(1)
    y, _ = sf.read(DEMO[1], always_2d=False); other = y if y.ndim == 1 else y.mean(1)
    from scipy.signal import butter, sosfilt
    carved = sosfilt(butter(4, 400, btype="highpass", fs=sr, output="sos"), other)
    la = os.path.join(TMP, "la.wav"); ob = os.path.join(TMP, "ob.wav"); cv = os.path.join(TMP, "cv.wav")
    sf.write(la, lead, sr); sf.write(ob, other, sr); sf.write(cv, carved, sr)
    before = AN.masking(la, ob)["worst_value"]
    after = AN.masking(la, cv)["worst_value"]
    assert after <= before + 1e-6, f"carving raised masking {before}->{after}"
check("masking metric is loudness-aware (carving lowers it)", t_masking_direction)


# --------------------------------------------------------------------------
section("harmony engine")
import harmony as H


def t_balance_basic():
    rep = H.balance(DEMO, os.path.join(TMP, "bal"), lead="mid.wav")
    assert len(rep.tracks) == 3
    mix, sr = sf.read(os.path.join(TMP, "bal", "preview_mix.wav"))
    assert np.all(np.isfinite(mix))
    assert 20 * np.log10(np.max(np.abs(mix)) + 1e-12) <= -0.9, "mix clips"
check("balance produces a clean, non-clipping mix", t_balance_basic)


def _timeline_spread(rep, subdir):
    starts = {t["name"]: t.get("start_ms", 0.0) / 1000.0 for t in rep.tracks}
    tl = {}
    for name, fn in [("mid.wav", "lead_mid.wav"), ("low.wav", "harmony_low.wav"), ("super high.wav", "harmony_super high.wav")]:
        x, sr = sf.read(os.path.join(TMP, subdir, "stems", fn), always_2d=False)
        onset = H.detect_downbeat(x if x.ndim == 1 else x.mean(1), sr) / sr
        tl[name] = starts.get(name, 0.0) + onset - (t2["trim_ms"] / 1000.0 if (t2 := next((t for t in rep.tracks if t["name"] == name), None)) else 0.0)
    return max(tl.values()) - min(tl.values())


def t_onset_align():
    # pure onset placement (stems written unshifted, positioned by start/trim)
    # should line the takes up tightly on the timeline.
    cfg = H.BalanceConfig(smart_place=False)
    rep = H.balance(DEMO, os.path.join(TMP, "al"), lead="mid.wav", config=cfg)
    spread = _timeline_spread(rep, "al")
    assert spread < 0.2, f"onset placement didn't line up takes, timeline spread {spread:.3f}s"
check("onset placement lines up takes on the timeline (low.wav was 1.66s early)", t_onset_align)


def t_smart_place_bounded():
    # content/harmony refinement must stay near the onset prior (no absurd drift)
    rep = H.balance(DEMO, os.path.join(TMP, "sm"), lead="mid.wav")  # smart_place default on
    spread = _timeline_spread(rep, "sm")
    assert spread < 1.6, f"smart placement drifted too far, timeline spread {spread:.3f}s"
    assert any("placed by" in n for n in rep.notes), "smart placement didn't report a mode"
check("smart placement refines within a bounded window", t_smart_place_bounded)


def t_beat_sampled():
    rep = H.balance(DEMO, os.path.join(TMP, "beat"), lead="mid.wav", beat=H.BeatConfig(enabled=True))
    assert rep.beat_style in PAT.PATTERNS
    assert os.path.exists(os.path.join(TMP, "beat", "stems", "beat.wav"))
    mix, sr = sf.read(os.path.join(TMP, "beat", "preview_mix.wav"))
    assert 20 * np.log10(np.max(np.abs(mix)) + 1e-12) <= -0.9, "beat mix clips"
    rep2 = H.balance(DEMO, os.path.join(TMP, "beat2"), lead="mid.wav", beat=H.BeatConfig(enabled=True, style="trap"))
    assert rep2.beat_style == "trap"
check("sampled beat integrates, auto + forced style, no clipping", t_beat_sampled)


def t_beat_simple_legacy():
    rep = H.balance(DEMO, os.path.join(TMP, "bs"), lead="mid.wav", beat=H.BeatConfig(enabled=True, engine="simple"))
    assert rep.beat_style == "simple"
check("legacy 'simple' beat engine still works", t_beat_simple_legacy)


def t_backing():
    rep = H.balance(DEMO, os.path.join(TMP, "bk"), lead="mid.wav",
                    backing=H.BackingConfig(pad=True, bass=True))
    assert rep.key and rep.progression
    for fn in ("synth_pad.wav", "bass.wav"):
        assert os.path.exists(os.path.join(TMP, "bk", "stems", fn))
    mix, sr = sf.read(os.path.join(TMP, "bk", "preview_mix.wav"))
    assert 20 * np.log10(np.max(np.abs(mix)) + 1e-12) <= -0.9, "backing mix clips"
check("harmonic backing (pad+bass) renders in key, no clipping", t_backing)


# --------------------------------------------------------------------------
section("producer (plain-language)")
import producer as P


def t_parse_ops():
    T, L = ["mid.wav", "low.wav", "super high.wav"], "mid.wav"
    def op(phrase):
        return [e["op"] for e in P.parse(phrase, T, L)]
    assert "level" in op("the low part is too loud")
    assert "width" in op("make the harmonies wider")
    assert "bright" in op("more air on the top")
    assert "space" in op("add some space")
    assert "beat" in op("add a lofi beat")
    assert "backing" in op("add a synth pad")
    assert "reset" in op("reset")
    assert "undo" in op("undo")
check("all producer ops parse from natural phrasing", t_parse_ops)


def t_session_undo_reset():
    s = P.ProducerSession(DEMO, os.path.join(TMP, "sess"), lead="mid.wav")
    s.apply("the low part is too loud")
    trimmed = s.adj["low.wav"].gain_trim_db
    assert trimmed < 0
    s.apply("undo")
    assert s.adj["low.wav"].gain_trim_db == 0, "undo didn't restore"
    s.apply("add a trap beat")
    assert s.beat.enabled
    s.apply("reset")
    assert not s.beat.enabled and s.adj["low.wav"].gain_trim_db == 0, "reset didn't clear"
check("session undo restores and reset clears (incl. beat/backing)", t_session_undo_reset)


# --------------------------------------------------------------------------
section("llm translator (offline)")
import llm_parser as LP


def t_translator():
    T, L = ["mid.wav", "low.wav"], "mid.wav"
    def one(intent):
        base = {"op": "level", "targets": [], "direction": "none", "magnitude": "normal",
                "position": "none", "bpm": 0, "element": "none", "progression": "none",
                "key": "", "beat_style": "auto"}
        base.update(intent)
        return LP._to_edits([base], T, L)[0]
    assert one({"op": "level", "targets": ["low.wav"], "direction": "decrease"})["amount"] < 0
    assert one({"op": "beat", "direction": "increase", "beat_style": "trap"})["style"] == "trap"
    assert one({"op": "backing", "direction": "increase", "element": "pad", "progression": "sad"})["progression"] == "sad"
    assert one({"op": "width", "direction": "set"})["amount"] <= -90
check("LLM intent -> edit translation covers ops incl. beat style", t_translator)


# --------------------------------------------------------------------------
section("agent tools (ears + moves)")
import agent as AG


def t_agent_tools():
    s = P.ProducerSession(DEMO, os.path.join(TMP, "agent"), lead="mid.wav")
    s.render()
    h = AG.hear(s)
    assert "issues" in h and "tracks" in h and "masking" in h
    out = AG.TOOL_FNS["set_lowcut"](s, track="low.wav", hz=300)
    assert out["ok"] and "hear" in out
    assert s.adj["low.wav"].extra_hpf_hz == 300
    AG.TOOL_FNS["add_beat"](s)
    assert s.beat.enabled
check("agent hear() + tool functions mutate and re-render", t_agent_tools)


# --------------------------------------------------------------------------
section("server endpoints (in-process)")


def t_server():
    from fastapi.testclient import TestClient
    sys.path.insert(0, os.path.join(ROOT, "app"))
    import importlib
    srv = importlib.import_module("app.server")
    c = TestClient(srv.app)
    r = c.post("/api/session", json={"use_llm": False}); assert r.status_code == 200, r.text
    sid = r.json()["id"]
    r = c.post(f"/api/session/{sid}/command", json={"text": "add a trap beat"})
    assert r.status_code == 200, r.text
    assert r.json()["project"]["beat_style"] == "trap", r.text
    names = [t["name"] for t in r.json()["project"]["tracks"]]
    assert "beat" in names, names
    # file serving
    stem = r.json()["project"]["tracks"][0]["file"]
    assert c.get(f"/api/session/{sid}/file", params={"path": stem}).status_code == 200
    # upload
    with open(DEMO[0], "rb") as a, open(DEMO[1], "rb") as b:
        r = c.post("/api/upload", files=[("files", ("mid.wav", a, "audio/wav")),
                                         ("files", ("low.wav", b, "audio/wav"))])
    assert r.status_code == 200, r.text
    sid2 = r.json()["id"]
    # add_take + set lead
    with open(DEMO[2], "rb") as f:
        r = c.post(f"/api/session/{sid2}/add_take", files={"file": ("rec.wav", f, "audio/wav")}, data={"name": "rec.wav"})
    assert r.status_code == 200 and "rec.wav" in [t["name"] for t in r.json()["project"]["tracks"]], r.text
    r = c.post(f"/api/session/{sid2}/lead", params={"track": "low.wav"})
    assert r.status_code == 200 and r.json()["project"]["lead"] == "low.wav"
    # remove_take: sid2 now has mid/low/rec (3) — removing one leaves 2; a further remove is refused
    r = c.post(f"/api/session/{sid2}/remove_take", params={"track": "rec.wav"})
    assert r.status_code == 200 and "rec.wav" not in [t["name"] for t in r.json()["project"]["tracks"]], r.text
    r = c.post(f"/api/session/{sid2}/remove_take", params={"track": "mid.wav"})
    assert r.status_code == 400, "should refuse dropping below two takes"
    # save (bundle) -> load round-trip preserves lead/beat/backing + takes
    c.post(f"/api/session/{sid}/command", json={"text": "add a lofi beat"})
    c.post(f"/api/session/{sid}/command", json={"text": "add a synth pad"})
    bundle = c.get(f"/api/session/{sid}/bundle").json()
    assert len(bundle["takes"]) >= 2 and bundle["beat"]["style"] == "lofi_swing"
    assert bundle["backing"]["pad"] is True
    loaded = c.post("/api/load", json={"lead": bundle["lead"], "beat": bundle["beat"],
                                       "backing": bundle["backing"], "takes": bundle["takes"]})
    assert loaded.status_code == 200, loaded.text
    names = [t["name"] for t in loaded.json()["project"]["tracks"]]
    assert "beat" in names and "synth pad" in names, names
    assert loaded.json()["project"]["beat_style"] == "lofi_swing"
check("all HTTP endpoints work (create/command/upload/add_take/lead/file)", t_server)


# --------------------------------------------------------------------------
print("\n" + ("=" * 52))
if _fail:
    print(f"FAILED: {len(_fail)} check(s): {', '.join(_fail)}")
    sys.exit(1)
print("ALL CHECKS PASSED")
