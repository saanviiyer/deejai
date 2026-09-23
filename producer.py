"""
deejai producer — plain-language control over the balancer
==========================================================

A musician talks to the mix instead of editing parameters:

    > the low part is too loud
    > make the harmonies wider
    > give the top a bit more air and some space
    > undo

Each line is parsed into structured edits, stacked onto the session state, and
the whole stack is re-rendered. The parser here is deterministic and runs
offline. It emits the same list-of-edits an LLM would, so swapping in an LLM
parser later means replacing one function (`parse`) and nothing else.

Run it on the do-you<3 harmony stack:

    python3 producer.py doyou_takes/mid.wav doyou_takes/low.wav "doyou_takes/super high.wav" \
        --lead mid.wav -o doyou_session

Then type requests at the prompt. Or pass a scripted run for testing:

    python3 producer.py <takes> --lead mid.wav -o out --do "low too loud; harmonies wider; top more air"
"""

from __future__ import annotations

import argparse
import copy
import os
import re
import shutil
import subprocess
import sys

import harmony as H


# step sizes for one unit of a request; modifiers scale these
STEP_LEVEL_DB = 2.0
STEP_PAN = 0.5
STEP_WIDTH = 0.15
STEP_BRIGHT_DB = 2.5
STEP_SPACE = 0.12
STEP_CLEAN_HZ = 90.0

SMALL = 0.5   # "a bit", "slightly"
LARGE = 2.0   # "a lot", "way", "much"


# ---------------------------------------------------------------------------
# parsing: plain language -> structured edits (the LLM-replaceable seam)
# ---------------------------------------------------------------------------

def _aliases(tracks: list[str]) -> dict[str, list[str]]:
    """Map each track to words a musician might call it. Derived from the
    filename tokens plus a few musical synonyms for high/low."""
    out: dict[str, list[str]] = {}
    for t in tracks:
        stem = os.path.splitext(t)[0].lower()
        toks = [w for w in "".join(c if c.isalnum() else " " for c in stem).split() if len(w) >= 2]
        al = set(toks)
        if "high" in al or "super" in al:
            al |= {"top", "high", "treble", "soprano", "upper"}
        if "low" in al:
            al |= {"bottom", "low", "bass", "under"}
        if "mid" in al:
            al |= {"mid", "middle", "center", "centre"}
        out[t] = sorted(al)
    return out


def _magnitude(phrase: str) -> float:
    if any(w in phrase for w in ["a bit", "bit ", "slightly", "a little", "little", "touch", "tad", "hair"]):
        return SMALL
    if any(w in phrase for w in ["a lot", "lot ", " way ", "much ", "way more", "tons", "loads", "really", "far ", "heaps"]):
        return LARGE
    return 1.0


def _expand_targets(targets: list[str], tracks: list[str], lead: str) -> list[str]:
    """Expand group words ('harmonies'/'lead'/'all') and pass filenames through.
    Shared with the LLM parser so both resolve targets the same way."""
    harmonies = [t for t in tracks if t != lead]
    out: list[str] = []
    for t in targets:
        low = t.lower()
        if low in ("harmonies", "harmony", "backing"):
            out.extend(harmonies)
        elif low in ("lead", "main", "melody"):
            out.append(lead)
        elif low in ("all", "everything", "mix"):
            out.extend(tracks)
        elif t in tracks:
            out.append(t)
    # de-dupe, keep order
    seen: set[str] = set()
    return [t for t in out if not (t in seen or seen.add(t))]


_PC = {"c": 0, "c#": 1, "db": 1, "d": 2, "d#": 3, "eb": 3, "e": 4, "f": 5, "f#": 6,
       "gb": 6, "g": 7, "g#": 8, "ab": 8, "a": 9, "a#": 10, "bb": 10, "b": 11}


def _parse_key(c: str):
    """Pull a musical key out of a phrase like 'in C minor' or 'key of A'."""
    m = re.search(r"\b(?:in|key of)\s+([a-g])\s*(#|b|sharp|flat)?\s*(major|minor|min|maj)?", c)
    if not m:
        return None
    acc = {"sharp": "#", "flat": "b", "#": "#", "b": "b", None: ""}[m.group(2)]
    pc = _PC.get(m.group(1) + acc)
    if pc is None:
        return None
    mode = "minor" if (m.group(3) or "").startswith("min") else "major"
    return (pc, mode)


_PROG_WORDS = {
    "sad": ["sad", "melancholy", "emotional", "moody"],
    "50s": ["50s", "doo wop", "doowop", "throwback"],
    "ballad": ["ballad"],
    "pop": ["happy", "upbeat", "bright", "poppy"],
}


def _key_name(key) -> str:
    """Render a (tonic, mode) tuple as 'A minor'."""
    if not key:
        return ""
    return f"{H.PC_NAMES[key[0]]} {key[1]}"


def _parse_progression(c: str):
    for name, words in _PROG_WORDS.items():
        if any(w in c for w in words):
            return name
    return None


_BEAT_STYLE_WORDS = {
    "trap": ["trap"],
    "lofi_swing": ["lofi", "lo-fi", "lo fi", "chill"],
    "boom_bap": ["boom bap", "boombap", "hip hop", "hip-hop", "hiphop", "old school"],
    "four_on_floor": ["four on the floor", "four-on-the-floor", "house", "edm", "dance", "club"],
    "ballad": ["ballad", "slow beat"],
    "pop_backbeat": ["pop beat", "pop"],
}


def _parse_beat_style(c: str):
    for name, words in _BEAT_STYLE_WORDS.items():
        if any(w in c for w in words):
            return name
    return None


def _resolve_targets(phrase: str, tracks: list[str], lead: str) -> list[str]:
    harmonies = [t for t in tracks if t != lead]
    if any(w in phrase for w in ["everything", "all of", "all tracks", "whole mix", "the mix", "the whole", "all three", "each"]):
        return list(tracks)
    if any(w in phrase for w in ["harmon", "backing", "background", "the backs", "back vocals"]):
        return harmonies
    if any(w in phrase for w in ["lead", "main vocal", "the main", "melody", "lead vocal"]):
        return [lead]
    hits = []
    for t, al in _aliases(tracks).items():
        if any(a in phrase for a in al):
            hits.append(t)
    return hits


def _level_sign(phrase: str) -> int | None:
    if any(k in phrase for k in ["too loud", "too much", "too hot", "too high", "overpowering", "too strong", "drowning", "drowns", "burying"]):
        return -1
    if any(k in phrase for k in ["too quiet", "too soft", "too low", "not loud enough", "cant hear", "can't hear", "barely hear", "need more", "bring it up"]):
        return +1
    if any(k in phrase for k in ["louder", "turn up", "bring up", "boost", "raise", "lift", "more of", "up "]):
        return +1
    if any(k in phrase for k in ["quieter", "turn down", "bring down", "lower", "reduce", "less of", "softer", "pull back", "back off", "duck"]):
        return -1
    return None


def parse(command: str, tracks: list[str], lead: str) -> list[dict]:
    """Turn one line into a list of edit dicts. Each edit:
      {op, targets, amount, note}
    op in: level, pan, width, bright, clean_low, space, reset, undo, lead, unknown
    """
    edits: list[dict] = []
    for clause in _split(command.lower().strip()):
        e = _parse_clause(clause, tracks, lead)
        if e:
            edits.extend(e)
    return edits


def _split(command: str) -> list[str]:
    for sep in [";", " and then ", " then ", " and ", ","]:
        command = command.replace(sep, "|")
    return [c.strip() for c in command.split("|") if c.strip()]


def _parse_clause(c: str, tracks: list[str], lead: str) -> list[dict]:
    mag = _magnitude(c)

    if any(w in c for w in ["reset", "start over", "revert", "default", "clean slate"]):
        return [{"op": "reset", "targets": [], "amount": 0, "note": "reset to the automatic balance"}]
    if any(w in c for w in ["undo", "go back", "never mind", "nevermind"]):
        return [{"op": "undo", "targets": [], "amount": 0, "note": "undo last change"}]

    if "lead" in c and any(w in c for w in ["make", "set", " is ", "should be"]):
        tg = [t for t in _resolve_targets(c, tracks, lead) if t != lead]
        if tg:
            return [{"op": "lead", "targets": [tg[0]], "amount": 0, "note": f"make {tg[0]} the lead"}]

    # beat / drums under the vocals
    if any(w in c for w in ["beat", "drum", "rhythm", "percussion", "groove"]):
        remove = any(w in c for w in ["no beat", "remove", "without", "drop the beat",
                                      "take out", "turn off", "no drum", "stop the beat"])
        m = re.search(r"(\d{2,3})\s*bpm", c) or re.search(r"\bat\s+(\d{2,3})\b", c)
        bpm = float(m.group(1)) if m else None
        return [{"op": "beat", "targets": [], "amount": 0 if remove else 1,
                 "bpm": bpm, "style": _parse_beat_style(c), "note": "beat off" if remove else "beat on"}]

    # harmonic backing: synth pad / bassline / arpeggio over a chord progression
    _has_elem = any(w in c for w in ["synth", "pad", "chord", "bass", "arp", "backing",
                                     "instrumental", "accompan", "keys"])
    prog, key = _parse_progression(c), _parse_key(c)
    if _has_elem or prog or key or "progression" in c:
        remove = any(w in c for w in ["no ", "remove", "without", "take out",
                                      "turn off", "drop the", "get rid"])
        # progression/key-only tweak: change it without toggling instruments
        if not _has_elem and (prog or key) and not remove:
            return [{"op": "backing", "targets": [], "amount": 2, "element": "none",
                     "progression": prog, "key": key, "note": "backing tweak"}]
        if "bass" in c:
            el = "bass"
        elif "arp" in c:
            el = "arp"
        elif any(w in c for w in ["synth", "pad", "chord", "keys"]):
            el = "pad"
        else:
            el = "all"
        return [{"op": "backing", "targets": [], "amount": 0 if remove else 1,
                 "element": el, "progression": prog, "key": key, "note": "backing"}]

    targets = _resolve_targets(c, tracks, lead) or list(tracks)

    # pan
    if any(w in c for w in ["left", "right", "center", "centre", "pan", "middle"]) and "space" not in c:
        if any(w in c for w in ["center", "centre", "middle"]):
            val = 0.0
        else:
            direction = -1 if "left" in c else 1
            depth = 0.9 if "hard" in c else (0.25 if mag == SMALL else 0.5)
            val = direction * depth
        return [{"op": "pan", "targets": targets, "amount": val, "note": f"pan to {round(val,2)}"}]

    # width / stereo image
    if any(w in c for w in ["wide", "widen", "spread", "stereo", "narrow", "tight", "mono", "closer together"]):
        if any(w in c for w in ["narrow", "tight", "mono", "closer", "less wide", "bring them in", "bring in"]):
            amt = -STEP_WIDTH * mag if "mono" not in c else -99.0
            note = "narrower" if "mono" not in c else "collapse toward mono"
        else:
            amt = STEP_WIDTH * mag
            note = "wider"
        return [{"op": "width", "targets": [], "amount": amt, "note": note}]

    # space / reverb
    if any(w in c for w in ["reverb", "space", "echo", "room", "depth", "ambien", "wet", "lush", "dry", "roomy"]):
        neg = any(w in c for w in ["dry", "less reverb", "less space", "remove", "no reverb", "kill the reverb", "drier"])
        amt = (-STEP_SPACE if neg else STEP_SPACE) * mag
        return [{"op": "space", "targets": targets, "amount": amt, "note": ("less space" if neg else "more space")}]

    # tone
    if any(w in c for w in ["muddy", "mud", "boom", "boomy", "clean up the low", "less low", "clean low"]):
        return [{"op": "clean_low", "targets": targets, "amount": STEP_CLEAN_HZ * mag, "note": "clear the low end"}]
    if any(w in c for w in ["bright", "air", "treble", "crisp", "sharp", "present", "clarity", "shimmer", "dark", "warm", "dull", "mellow", "harsh", "muffled"]):
        neg = any(w in c for w in ["dark", "warm", "dull", "mellow", "less bright", "less air", "softer tone", "less harsh", "muffled"])
        amt = (-STEP_BRIGHT_DB if neg else STEP_BRIGHT_DB) * mag
        return [{"op": "bright", "targets": targets, "amount": amt, "note": ("warmer" if neg else "brighter")}]

    # level
    sign = _level_sign(c)
    if sign is not None:
        amt = sign * STEP_LEVEL_DB * mag
        return [{"op": "level", "targets": targets, "amount": amt, "note": ("louder" if sign > 0 else "quieter")}]

    return [{"op": "unknown", "targets": [], "amount": 0, "note": c}]


# ---------------------------------------------------------------------------
# session: hold state, apply edits, re-render
# ---------------------------------------------------------------------------

class ProducerSession:
    def __init__(self, inputs: list[str], out_dir: str, lead: str | None = None,
                 align: bool = False, parser=None, beat_snap: bool = False, tune: float = 0.0):
        self.inputs = inputs
        self.out_dir = out_dir
        self.lead = lead or os.path.basename(inputs[0])
        self.tracks = [os.path.basename(p) for p in inputs]
        self._align = align
        self._beat_snap, self._beat_snap_div, self._tune, self._grid_ref = beat_snap, 1.0, tune, None
        self._grid_phase_s = None
        self.parser = parser or parse  # swappable: rule-based by default, LLM if given
        self.cfg = H.BalanceConfig(align=align, beat_snap=beat_snap, tune=tune)
        self.adj: dict[str, H.TrackAdjust] = {t: H.TrackAdjust() for t in self.tracks}
        self.beat = H.BeatConfig()
        self.backing = H.BackingConfig()
        self.history: list[tuple] = []

    def set_align(self, beat_snap: bool, div: float, tune: float, grid_ref: str | None = None,
                  grid_phase_s: float | None = None):
        """Change placement/tuning settings; caller re-renders to apply."""
        self._beat_snap, self._beat_snap_div, self._tune = beat_snap, div, tune
        self._grid_ref = grid_ref or None
        self._grid_phase_s = grid_phase_s
        self.cfg.beat_snap = beat_snap
        self.cfg.beat_snap_div = div
        self.cfg.tune = tune
        self.cfg.grid_ref = self._grid_ref
        self.cfg.grid_phase_s = grid_phase_s

    def _snapshot(self):
        self.history.append((copy.deepcopy(self.cfg), copy.deepcopy(self.adj),
                             copy.deepcopy(self.beat), copy.deepcopy(self.backing), self.lead))

    def apply(self, command: str) -> tuple[list[str], list[dict]]:
        try:
            edits = self.parser(command, self.tracks, self.lead)
        except Exception as e:
            # a live LLM parser can fail (auth, network); don't lose the session
            edits = parse(command, self.tracks, self.lead)
            edits.insert(0, {"op": "_note", "targets": [], "amount": 0,
                             "note": f"Claude parser failed ({e}); used the rule-based one"})
        notes = [e["note"] for e in edits if e["op"] == "_note"]
        edits = [e for e in edits if e["op"] != "_note"]
        if any(e["op"] == "undo" for e in edits):
            return notes + self._undo(), edits
        if not edits or all(e["op"] == "unknown" for e in edits):
            return (notes + ["didn't catch that. try things like 'low too loud', 'harmonies wider', "
                     "'add space', 'add a simple beat', 'add a synth pad', 'add a bassline', 'reset'"], edits)
        self._snapshot()
        messages = list(notes)
        for e in edits:
            messages.extend(self._apply_edit(e))
        return messages, edits

    def _apply_edit(self, e: dict) -> list[str]:
        op, targets, amt = e["op"], e["targets"], e["amount"]
        msgs = []
        if op == "reset":
            self.cfg = H.BalanceConfig(align=self._align, beat_snap=self._beat_snap, beat_snap_div=self._beat_snap_div, tune=self._tune, grid_ref=self._grid_ref, grid_phase_s=self._grid_phase_s)
            self.adj = {t: H.TrackAdjust() for t in self.tracks}
            self.beat = H.BeatConfig()
            self.backing = H.BackingConfig()
            return ["reset to the automatic balance"]
        if op == "lead":
            self.lead = targets[0]
            return [f"lead is now {self.lead}"]
        if op == "beat":
            if amt <= 0:
                self.beat.enabled = False
                return ["beat off"]
            self.beat.enabled = True
            self.beat.bpm = e.get("bpm")      # None -> detect from the vocal
            self.beat.style = e.get("style")  # None -> retrieve the fitting style
            where = f"at {int(self.beat.bpm)} BPM" if self.beat.bpm else "at the vocal tempo"
            what = self.beat.style if self.beat.style else "a fitting beat"
            return [f"{what} on, {where}"]
        if op == "backing":
            if e.get("progression"):
                self.backing.progression = e["progression"]
            if e.get("key"):
                self.backing.key = e["key"]
            if amt == 2:  # progression/key change only, don't toggle instruments
                where = f" in {_key_name(self.backing.key)}" if self.backing.key else ""
                return [f"progression -> {self.backing.progression}{where}"]
            el, on = e.get("element", "all"), amt > 0
            names = {"pad": ["pad"], "synth": ["pad"], "chords": ["pad"], "bass": ["bass"],
                     "arp": ["arp"], "all": ["pad", "bass"]}.get(el, ["pad", "bass"])
            for n in names:
                setattr(self.backing, n, on)
            state = "on" if on else "off"
            extra = f", {self.backing.progression} progression" if on else ""
            return [f"{'/'.join(names)} {state}{extra} (key + tempo from the vocal)"]
        if op == "width":
            if amt <= -90:
                self.cfg.harmony_pan_spread = 0.0
            else:
                self.cfg.harmony_pan_spread = float(min(1.0, max(0.0, self.cfg.harmony_pan_spread + amt)))
            return [f"stereo spread -> {round(self.cfg.harmony_pan_spread, 2)} ({e['note']})"]
        for t in targets:
            a = self.adj[t]
            if op == "level":
                a.gain_trim_db += amt
                msgs.append(f"{t}: {a.gain_trim_db:+.1f} dB ({e['note']})")
            elif op == "pan":
                a.pan = float(max(-1.0, min(1.0, amt)))
                msgs.append(f"{t}: pan {a.pan:+.2f}")
            elif op == "bright":
                a.bright_db += amt
                msgs.append(f"{t}: {a.bright_db:+.1f} dB shelf ({e['note']})")
            elif op == "clean_low":
                a.extra_hpf_hz = float(min(400.0, max(a.extra_hpf_hz, 140.0) + amt))
                msgs.append(f"{t}: low cut -> {int(a.extra_hpf_hz)} Hz")
            elif op == "space":
                a.reverb_wet = float(max(0.0, min(0.9, a.reverb_wet + amt)))
                msgs.append(f"{t}: reverb {a.reverb_wet:.2f} ({e['note']})")
        return msgs or [f"no matching track for '{e['note']}'"]

    def _undo(self) -> list[str]:
        if not self.history:
            return ["nothing to undo"]
        self.cfg, self.adj, self.beat, self.backing, self.lead = self.history.pop()
        return ["undone"]

    def render(self) -> H.BalanceReport:
        return H.balance(self.inputs, self.out_dir, lead=self.lead,
                         config=self.cfg, adjustments=self.adj,
                         beat=self.beat, backing=self.backing)


# ---------------------------------------------------------------------------
# cli: interactive prompt or scripted run
# ---------------------------------------------------------------------------

def _preview_path(session: ProducerSession) -> str:
    return os.path.join(session.out_dir, "preview_mix.wav")


def _play(path: str) -> None:
    """Open the current preview so the user can hear the revision. macOS `afplay`
    blocks until done; elsewhere hand off to the OS opener."""
    if sys.platform == "darwin" and shutil.which("afplay"):
        subprocess.run(["afplay", path])
    elif shutil.which("xdg-open"):
        subprocess.Popen(["xdg-open", path])
    else:
        print(f"  (open {path} to listen)")


def _reveal(session: ProducerSession) -> None:
    """Open the stems folder in Finder so the user can drag them into GarageBand."""
    stems = os.path.abspath(os.path.join(session.out_dir, "stems"))
    if sys.platform == "darwin" and shutil.which("open"):
        subprocess.Popen(["open", stems])
        print(f"  opened {stems} — drag these WAVs onto GarageBand's track area")
    else:
        print(f"  stems are in {stems}")


def _band_wavs(band_path: str) -> list[str]:
    """Every recorded WAV inside a GarageBand .band bundle."""
    import glob
    audio = os.path.join(band_path, "Media", "Audio Files")
    return sorted(glob.glob(os.path.join(audio, "*.wav")))


def _render_and_report(session: ProducerSession, play: bool) -> None:
    report = session.render()
    line = f"  preview -> {_preview_path(session)}"
    if report.beat_bpm:
        line += f"   [beat ~{report.beat_bpm} BPM]"
    if report.key:
        line += f"   [key {report.key}, {report.progression}]"
    print(line)
    if play:
        _play(_preview_path(session))


def main() -> None:
    ap = argparse.ArgumentParser(description="Talk to your mix in plain language.")
    ap.add_argument("inputs", nargs="*", help="WAV takes (or use --from-band)")
    ap.add_argument("--from-band", help="load every recorded take from a GarageBand .band bundle")
    ap.add_argument("--lead", help="filename of the lead/center take")
    ap.add_argument("-o", "--out", default="producer_session", help="output directory")
    ap.add_argument("--align", action="store_true", help="enable timing alignment")
    ap.add_argument("--do", help="run a ';'-separated script of requests then exit (for testing)")
    ap.add_argument("--llm", action="store_true",
                    help="use the Claude parser (understands any phrasing; needs anthropic + credentials)")
    ap.add_argument("--play", action="store_true", help="play the preview after every change")
    args = ap.parse_args()

    inputs = list(args.inputs)
    if args.from_band:
        inputs = _band_wavs(args.from_band)
        print(f"loaded {len(inputs)} takes from {os.path.basename(args.from_band)}")
    if len(inputs) < 2:
        ap.error("need at least two takes (pass WAV files, or --from-band <project.band>)")

    parser = None
    mode = "rule-based"
    if args.llm:
        try:
            import llm_parser
            parser = llm_parser.LLMParser()
            mode = f"Claude ({parser.model})"
        except Exception as e:
            print(f"couldn't start the Claude parser ({e}); falling back to the rule-based one.")

    session = ProducerSession(inputs, args.out, lead=args.lead, align=args.align, parser=parser)
    print(f"deejai producer  |  {len(session.tracks)} takes, lead: {session.lead}  |  parser: {mode}")
    print(f"output folder: {os.path.abspath(args.out)}")
    _render_and_report(session, play=False)
    print("rendered the starting balance. commands: 'play' to hear it, "
          "'reveal' to open the stems in Finder, 'quit' to exit.")

    if args.do:
        for cmd in [c.strip() for c in args.do.split(";") if c.strip()]:
            print(f"\n> {cmd}")
            msgs, _ = session.apply(cmd)
            for m in msgs:
                print(f"  {m}")
            _render_and_report(session, play=args.play)
        return

    print("\ntell me what to change:")
    while True:
        try:
            cmd = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if cmd.lower() in {"quit", "exit", "q"}:
            break
        if not cmd:
            continue
        if cmd.lower() in {"play", "p", "listen"}:
            _play(_preview_path(session))
            continue
        if cmd.lower() in {"reveal", "show", "open", "stems"}:
            _reveal(session)
            continue
        msgs, _ = session.apply(cmd)
        for m in msgs:
            print(f"  {m}")
        _render_and_report(session, play=args.play)


if __name__ == "__main__":
    main()
