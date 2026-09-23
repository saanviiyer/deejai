"""
deejai agent — the AI-native producer loop
==========================================

Not a translator. The model *hears* the mix (structured analysis from
analysis.py), decides what to do, acts through tools, hears the result, and
iterates until the goal is met. That perceive -> act -> perceive loop is the
difference between AI-assisted and AI-native: the amount of a move comes from
what the audio actually shows, not a fixed preset step.

Tools operate on a producer.ProducerSession (same engine as everywhere else).
Needs Claude credentials to run the loop; the tool functions themselves are
plain Python and are unit-testable without a key (see the __main__ demo).
"""

from __future__ import annotations

import os

import analysis as A
import harmony as H
import producer as P


MODEL = "claude-opus-5"


# ---------------------------------------------------------------------------
# hearing: turn the current session's audio into findings the model reads
# ---------------------------------------------------------------------------

def hear(session: P.ProducerSession) -> dict:
    stems = os.path.join(session.out_dir, "stems")
    lead_stem = None
    tracks = {}
    for t_name in session.tracks:
        role = "lead" if t_name == session.lead else "harmony"
        fn = f"{role}_{os.path.splitext(t_name)[0]}.wav"
        path = os.path.join(stems, fn)
        if not os.path.exists(path):
            continue
        tracks[t_name] = path
        if role == "lead":
            lead_stem = path

    lead_lufs = A.take_stats(lead_stem)["lufs"] if lead_stem else None
    findings = {"lead": session.lead, "tracks": {}, "masking": {}, "issues": []}
    for name, path in tracks.items():
        s = A.take_stats(path)
        rel = round(s["lufs"] - lead_lufs, 1) if (lead_lufs is not None and name != session.lead) else 0.0
        findings["tracks"][name] = {"lufs": s["lufs"], "rel_to_lead_db": rel,
                                    "air": s["harshness"], "clipped": s["clipped_samples"]}
        if name != session.lead and lead_stem:
            m = A.masking(lead_stem, path)
            findings["masking"][name] = {"worst_band": m["worst_band"], "overlap": m["worst_value"]}

    # derive plain-language issues (the perception summary the model acts on)
    for name, tr in findings["tracks"].items():
        if name != session.lead and tr["rel_to_lead_db"] > -1:
            findings["issues"].append(f"{name} is only {tr['rel_to_lead_db']} dB under the lead; harmonies should tuck under")
        if tr["air"] < 0.05:
            findings["issues"].append(f"{name} is dull/boxy (almost no energy above 2 kHz) — needs air")
        if tr["clipped"] > 50:
            findings["issues"].append(f"{name} is clipping ({tr['clipped']} samples)")
    for name, mk in findings["masking"].items():
        if mk["overlap"] > 0.3:
            findings["issues"].append(f"{name} masks the lead in the {mk['worst_band']} band (overlap {mk['overlap']}) — carve it there")

    findings["beat"] = {"on": session.beat.enabled, "bpm": session.beat.bpm}
    findings["backing"] = {"pad": session.backing.pad, "bass": session.backing.bass,
                           "arp": session.backing.arp, "progression": session.backing.progression}
    return findings


# ---------------------------------------------------------------------------
# tools: the moves the model can make (plain Python, mutate + re-render)
# ---------------------------------------------------------------------------

def _adj(session, track):
    return session.adj.setdefault(track, H.TrackAdjust())


TOOL_FNS = {
    "hear": lambda s, **k: hear(s),
    "set_level":    lambda s, track, db, **k: _set(s, track, "gain_trim_db", _adj(s, track).gain_trim_db + db),
    "set_lowcut":   lambda s, track, hz, **k: _set(s, track, "extra_hpf_hz", hz),
    "set_air":      lambda s, track, db, **k: _set(s, track, "bright_db", _adj(s, track).bright_db + db),
    "set_pan":      lambda s, track, pan, **k: _set(s, track, "pan", pan),
    "set_reverb":   lambda s, track, wet, **k: _set(s, track, "reverb_wet", wet),
    "set_width":    lambda s, spread, **k: _setcfg(s, "harmony_pan_spread", spread),
    "add_beat":     lambda s, bpm=None, **k: _beat(s, True, bpm),
    "remove_beat":  lambda s, **k: _beat(s, False, None),
    "add_backing":  lambda s, element, progression=None, key=None, **k: _backing(s, element, True, progression, key),
    "remove_backing": lambda s, element, **k: _backing(s, element, False, None, None),
}


def _set(session, track, field, value):
    setattr(_adj(session, track), field, value)
    return {"ok": True, "hear": hear(_render(session))}


def _setcfg(session, field, value):
    setattr(session.cfg, field, value)
    return {"ok": True, "hear": hear(_render(session))}


def _beat(session, on, bpm):
    session.beat.enabled = on
    if bpm:
        session.beat.bpm = bpm
    return {"ok": True, "hear": hear(_render(session))}


def _backing(session, element, on, progression, key):
    names = {"pad": ["pad"], "bass": ["bass"], "arp": ["arp"], "all": ["pad", "bass"]}.get(element, ["pad"])
    for n in names:
        setattr(session.backing, n, on)
    if progression:
        session.backing.progression = progression
    if key:
        session.backing.key = key
    return {"ok": True, "hear": hear(_render(session))}


def _render(session):
    session.render()
    return session


# tool schemas for the model
TRACK = {"type": "string", "description": "exact track filename or the lead"}
TOOLS = [
    {"name": "hear", "description": "Analyze the current mix: per-track loudness relative to the lead, "
     "where tracks mask each other (which band), air/dullness, and current beat/backing state. Call this "
     "first and after changes to check your work.", "input_schema": {"type": "object", "properties": {}}},
    {"name": "set_level", "description": "Add gain (dB, +louder/-quieter) to a track, on top of the balance.",
     "input_schema": {"type": "object", "properties": {"track": TRACK, "db": {"type": "number"}}, "required": ["track", "db"]}},
    {"name": "set_lowcut", "description": "Raise a track's high-pass cutoff (Hz) to clear low-mid mud/masking.",
     "input_schema": {"type": "object", "properties": {"track": TRACK, "hz": {"type": "number"}}, "required": ["track", "hz"]}},
    {"name": "set_air", "description": "Add a high-shelf (dB, +brighter/-warmer) to give a dull track presence.",
     "input_schema": {"type": "object", "properties": {"track": TRACK, "db": {"type": "number"}}, "required": ["track", "db"]}},
    {"name": "set_pan", "description": "Place a track in the stereo field (-1 left .. 1 right).",
     "input_schema": {"type": "object", "properties": {"track": TRACK, "pan": {"type": "number"}}, "required": ["track", "pan"]}},
    {"name": "set_reverb", "description": "Set a track's reverb wet amount (0..0.9) for space.",
     "input_schema": {"type": "object", "properties": {"track": TRACK, "wet": {"type": "number"}}, "required": ["track", "wet"]}},
    {"name": "set_width", "description": "Stereo spread of the harmonies (0 mono .. 1 wide).",
     "input_schema": {"type": "object", "properties": {"spread": {"type": "number"}}, "required": ["spread"]}},
    {"name": "add_beat", "description": "Add a simple beat locked to the vocal tempo (bpm optional).",
     "input_schema": {"type": "object", "properties": {"bpm": {"type": "number"}}}},
    {"name": "remove_beat", "description": "Remove the beat.", "input_schema": {"type": "object", "properties": {}}},
    {"name": "add_backing", "description": "Add harmonic backing in the vocal's key: element pad/bass/arp/all, "
     "optional progression (pop/sad/50s/ballad) and key (e.g. 'A minor').",
     "input_schema": {"type": "object", "properties": {"element": {"type": "string"},
      "progression": {"type": "string"}, "key": {"type": "string"}}, "required": ["element"]}},
    {"name": "remove_backing", "description": "Remove a backing element (pad/bass/arp/all).",
     "input_schema": {"type": "object", "properties": {"element": {"type": "string"}}, "required": ["element"]}},
]

SYSTEM = (
    "You are a music producer working on a vocal harmony mix. You have ears: call `hear` to get the "
    "current analysis (loudness vs the lead, masking bands, dullness, clipping) and the `issues` list. "
    "Work the goal by making concrete moves with the tools, then call `hear` again to confirm each move "
    "did what you intended. Choose the SIZE of each move from what the analysis shows, not a fixed step: "
    "a 0.87 masking overlap needs a firmer cut than 0.35. Fix the issues you can measure (masking, dull/boxy "
    "tracks with no air, harmonies not tucked under the lead) before adding instruments. When the mix meets "
    "the goal and the issues are resolved, stop and give a one-paragraph summary of what you changed and why."
)


class AgentProducer:
    def __init__(self, session: P.ProducerSession, model: str = MODEL):
        import anthropic
        self.client = anthropic.Anthropic()
        self.session = session
        self.model = model

    def run(self, goal: str, max_steps: int = 12) -> list[dict]:
        """Agentic loop: hear -> act -> hear until the model stops calling tools."""
        messages = [{"role": "user", "content": f"Goal: {goal}\nStart by hearing the mix."}]
        transcript = []
        for _ in range(max_steps):
            resp = self.client.messages.create(
                model=self.model, max_tokens=4096, system=SYSTEM, tools=TOOLS, messages=messages)
            messages.append({"role": "assistant", "content": resp.content})
            for b in resp.content:
                if b.type == "text" and b.text.strip():
                    transcript.append({"say": b.text})
            calls = [b for b in resp.content if b.type == "tool_use"]
            if not calls:
                break
            results = []
            for call in calls:
                out = TOOL_FNS[call.name](self.session, **call.input)
                transcript.append({"tool": call.name, "input": call.input})
                results.append({"type": "tool_result", "tool_use_id": call.id,
                                "content": __import__("json").dumps(out)})
            messages.append({"role": "user", "content": results})
        return transcript


if __name__ == "__main__":
    # unit-test the tools + ears without a key: play the agent's likely plan by hand
    import json
    sess = P.ProducerSession(
        ["doyou_takes/mid.wav", "doyou_takes/low.wav", "doyou_takes/super high.wav"],
        "agent_demo", lead="mid.wav")
    sess.render()
    print("BEFORE:", json.dumps(hear(sess)["issues"], indent=2))
    # what an agent would do from the findings: tuck + carve masking + add air
    TOOL_FNS["set_lowcut"](sess, track="low.wav", hz=300)
    TOOL_FNS["set_lowcut"](sess, track="super high.wav", hz=320)
    TOOL_FNS["set_air"](sess, track="mid.wav", db=4)
    TOOL_FNS["set_air"](sess, track="low.wav", db=3)
    TOOL_FNS["set_air"](sess, track="super high.wav", db=3)
    print("AFTER:", json.dumps(hear(sess)["issues"], indent=2))
