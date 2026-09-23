"""
deejai LLM parser — plain language to structured edits, via Claude
=================================================================

Drop-in replacement for producer.parse(). Same signature, same output shape
(a list of edit dicts the ProducerSession already knows how to apply), so the
session and engine don't change at all — only the thing turning a sentence into
edits gets smarter.

The rule-based parser in producer.py understands a fixed vocabulary. This one
understands arbitrary phrasing ("the bottom voice is swallowing the melody",
"open it up but keep the lead dead center") because Claude classifies the
request into the same small op set, and this module maps that classification
back onto the exact step sizes the rule-based parser uses. Claude decides the
intent; the deterministic code decides the amount, so the two parsers stay
consistent and a musician can't get a wildly different move from the same words.

Needs the `anthropic` package and Claude credentials (ANTHROPIC_API_KEY, or an
`ant auth login` profile). If either is missing, ProducerSession falls back to
the offline rule-based parser and says so.
"""

from __future__ import annotations

import json

import producer as P  # reuse STEP_* sizes and target expansion


MODEL = "claude-opus-5"  # swap to "claude-haiku-4-5" for a faster, cheaper parse

# scale factor for one classified magnitude
_SCALE = {"slight": P.SMALL, "normal": 1.0, "strong": P.LARGE}
_PAN_VALUE = {"left": -0.5, "right": 0.5, "hard_left": -0.9, "hard_right": 0.9, "center": 0.0}

# JSON schema Claude must fill. Every edit carries all fields; unused ones are
# set to "none" so the schema stays flat and strict.
_SCHEMA = {
    "type": "object",
    "properties": {
        "edits": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "op": {"type": "string", "enum": [
                        "level", "pan", "width", "bright", "clean_low",
                        "space", "beat", "backing", "reset", "undo", "lead"]},
                    "targets": {"type": "array", "items": {"type": "string"}},
                    "direction": {"type": "string", "enum": ["increase", "decrease", "set", "none"]},
                    "magnitude": {"type": "string", "enum": ["slight", "normal", "strong"]},
                    "position": {"type": "string", "enum": [
                        "left", "right", "hard_left", "hard_right", "center", "none"]},
                    "bpm": {"type": "integer"},
                    "element": {"type": "string", "enum": ["pad", "bass", "arp", "all", "none"]},
                    "progression": {"type": "string", "enum": ["pop", "sad", "50s", "ballad", "none"]},
                    "key": {"type": "string"},
                    "beat_style": {"type": "string", "enum": [
                        "pop_backbeat", "four_on_floor", "boom_bap", "lofi_swing", "trap", "ballad", "auto"]},
                },
                "required": ["op", "targets", "direction", "magnitude", "position",
                             "bpm", "element", "progression", "key", "beat_style"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["edits"],
    "additionalProperties": False,
}


def _system_prompt(tracks: list[str], lead: str) -> str:
    harmonies = [t for t in tracks if t != lead]
    return (
        "You translate a singer's plain-language mixing request into structured edits "
        "for a vocal harmony balancer. You classify intent only. You never invent amounts; "
        "downstream code sets the actual dB/pan values from your classification.\n\n"
        f"Tracks in this mix: {tracks}. The lead (center) is '{lead}'. "
        f"The harmonies are {harmonies}.\n\n"
        "For each distinct change in the request, output one edit. Ops:\n"
        "- level: louder/quieter. direction increase|decrease, magnitude by how strongly.\n"
        "- pan: place a track in the stereo field. Set position; direction/magnitude ignored.\n"
        "- width: spread the harmonies. direction increase (wider) | decrease (tighter) | "
        "set (collapse to mono). targets ignored (always the harmonies).\n"
        "- bright: tone. direction increase (brighter/more air) | decrease (warmer/darker).\n"
        "- clean_low: clear low-end mud/boom. direction increase, magnitude by how much.\n"
        "- space: reverb/ambience. direction increase (more) | decrease (drier).\n"
        "- beat: a real-sample drum bed under the vocals, locked to the vocal tempo. "
        "direction increase (add a beat) | decrease (remove it). targets []. "
        "Set bpm to a number only if the user names one, else 0 (auto-detect the tempo). "
        "beat_style: pick a named style if the user asks for one (trap, lofi_swing, boom_bap, "
        "four_on_floor, ballad, pop_backbeat), else 'auto' to fit the style to the vocal.\n"
        "- backing: harmonic instruments synthesized in the vocal's own detected key and tempo. "
        "direction increase (add) | decrease (remove). element: 'pad' (synth chords), 'bass' "
        "(bassline), 'arp' (arpeggio), or 'all' (a pad+bass bed for 'backing track'/'instrumental'). "
        "progression: 'pop', 'sad', '50s', 'ballad', or 'none' to leave it. key: a note like 'C minor' "
        "only if the user names one, else empty string to auto-detect.\n"
        "- reset: undo all changes back to the automatic balance. targets [].\n"
        "- undo: revert only the last change. targets [].\n"
        "- lead: make a track the lead. targets is the one track.\n\n"
        "targets: use exact filenames from the track list, or the group words "
        "'harmonies', 'lead', or 'all'. If the request names no track, target 'all'. "
        "Map descriptions to tracks by their names (e.g. 'the top'/'the high one' is the "
        "highest-named part, 'the bottom'/'the low one' the lowest).\n\n"
        "magnitude: 'slight' for a bit/slightly/a touch, 'strong' for a lot/way/much, else 'normal'.\n"
        "Set every field on every edit; use 'none' (or empty string for key) where a field doesn't apply, "
        "and bpm 0 unless the user names a tempo. "
        "If the request isn't a mixing change, return an empty edits list."
    )


def _to_edits(intents: list[dict], tracks: list[str], lead: str) -> list[dict]:
    """Map Claude's classified intents onto the internal edit dicts, using the
    same step sizes the rule-based parser uses."""
    edits: list[dict] = []
    for it in intents:
        op = it["op"]
        scale = _SCALE.get(it.get("magnitude", "normal"), 1.0)
        sign = 1 if it.get("direction") == "increase" else -1
        targets = P._expand_targets(it.get("targets", []), tracks, lead)

        if op == "reset":
            edits.append({"op": "reset", "targets": [], "amount": 0, "note": "reset"})
        elif op == "undo":
            edits.append({"op": "undo", "targets": [], "amount": 0, "note": "undo"})
        elif op == "lead":
            tg = [t for t in targets if t != lead]
            if tg:
                edits.append({"op": "lead", "targets": [tg[0]], "amount": 0, "note": f"lead -> {tg[0]}"})
        elif op == "level":
            edits.append({"op": "level", "targets": targets, "amount": sign * P.STEP_LEVEL_DB * scale,
                          "note": "louder" if sign > 0 else "quieter"})
        elif op == "bright":
            edits.append({"op": "bright", "targets": targets, "amount": sign * P.STEP_BRIGHT_DB * scale,
                          "note": "brighter" if sign > 0 else "warmer"})
        elif op == "space":
            edits.append({"op": "space", "targets": targets, "amount": sign * P.STEP_SPACE * scale,
                          "note": "more space" if sign > 0 else "less space"})
        elif op == "clean_low":
            edits.append({"op": "clean_low", "targets": targets, "amount": P.STEP_CLEAN_HZ * scale,
                          "note": "clear the low end"})
        elif op == "beat":
            bpm = it.get("bpm") or None  # 0 -> auto-detect
            st = it.get("beat_style")
            st = None if st in (None, "", "auto", "none") else st
            edits.append({"op": "beat", "targets": [], "amount": 0 if sign < 0 else 1,
                          "bpm": bpm, "style": st, "note": "beat"})
        elif op == "backing":
            prog = it.get("progression")
            prog = None if prog in (None, "none", "") else prog
            key = P._parse_key(f"in {it.get('key', '')}") if it.get("key") not in (None, "", "none") else None
            edits.append({"op": "backing", "targets": [], "amount": 0 if sign < 0 else 1,
                          "element": it.get("element", "all"), "progression": prog,
                          "key": key, "note": "backing"})
        elif op == "pan":
            edits.append({"op": "pan", "targets": targets,
                          "amount": _PAN_VALUE.get(it.get("position", "center"), 0.0),
                          "note": f"pan {it.get('position')}"})
        elif op == "width":
            if it.get("direction") == "set":
                edits.append({"op": "width", "targets": [], "amount": -99.0, "note": "mono"})
            else:
                edits.append({"op": "width", "targets": [], "amount": sign * P.STEP_WIDTH * scale,
                              "note": "wider" if sign > 0 else "narrower"})
    return edits


class LLMParser:
    """Callable with the same signature as producer.parse. Constructing it
    imports the SDK and builds a client; a failure here means fall back."""

    def __init__(self, model: str = MODEL):
        import anthropic  # raises if not installed
        self.client = anthropic.Anthropic()  # resolves key or ant profile
        self.model = model

    def __call__(self, command: str, tracks: list[str], lead: str) -> list[dict]:
        resp = self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            system=_system_prompt(tracks, lead),
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": _SCHEMA}},
            messages=[{"role": "user", "content": command}],
        )
        if resp.stop_reason == "refusal":
            return [{"op": "unknown", "targets": [], "amount": 0, "note": command}]
        text = next((b.text for b in resp.content if b.type == "text"), "{}")
        intents = json.loads(text).get("edits", [])
        edits = _to_edits(intents, tracks, lead)
        return edits or [{"op": "unknown", "targets": [], "amount": 0, "note": command}]
