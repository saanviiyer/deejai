"""
deejai DAW backend
==================

Wraps the existing audio engine (harmony.py balancing/beat/backing, producer.py
plain-language layer, llm_parser.py) in a small HTTP API the browser DAW talks
to. The engine is unchanged; this just exposes it.

Run:
    python3 -m uvicorn app.server:app --reload --port 8000
    # or:  python3 app/server.py
then open http://localhost:8000
"""

from __future__ import annotations

import base64
import dataclasses
import os
import sys
import uuid

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# make the engine modules (one dir up) importable
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import producer as P  # noqa: E402
import harmony as H   # noqa: E402

app = FastAPI(title="deejai")

SESSIONS: dict[str, P.ProducerSession] = {}
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
SESSION_ROOT = os.path.join(ROOT, "app_sessions")
os.makedirs(SESSION_ROOT, exist_ok=True)

# the three-part harmony as the built-in demo takes
DEMO = [os.path.join(ROOT, "doyou_takes", f) for f in ("mid.wav", "low.wav", "super high.wav")]
DEMO_LEAD = "mid.wav"


# ---------------------------------------------------------------------------
# request bodies
# ---------------------------------------------------------------------------

class CreateBody(BaseModel):
    inputs: list[str] | None = None   # absolute WAV paths; None -> demo takes
    lead: str | None = None
    from_band: str | None = None      # a .band bundle to load every take from
    use_llm: bool = True


class CommandBody(BaseModel):
    text: str


class Take(BaseModel):
    name: str
    data: str   # base64-encoded WAV


class LoadBody(BaseModel):
    lead: str | None = None
    beat: dict = {}
    backing: dict = {}
    takes: list[Take]


# ---------------------------------------------------------------------------
# project serialization: current session state -> what the DAW draws
# ---------------------------------------------------------------------------

def project_dict(session: P.ProducerSession, report: H.BalanceReport) -> dict:
    tracks = []
    for t in report.tracks:  # vocals, carrying deejai's pan + timeline placement
        tracks.append({"file": t["out_stem"].replace(os.sep, "/"),
                       "name": t["name"], "role": t["role"], "pan": t["pan"],
                       "start": round(t.get("start_ms", 0.0) / 1000.0, 3),
                       "trim": round(t.get("trim_ms", 0.0) / 1000.0, 3)})
    # instrument stems, only those currently enabled
    if session.beat.enabled:
        tracks.append({"file": "stems/beat.wav", "name": "beat", "role": "beat", "pan": 0.0})
    if session.backing.pad:
        tracks.append({"file": "stems/synth_pad.wav", "name": "synth pad", "role": "pad", "pan": 0.0})
    if session.backing.bass:
        tracks.append({"file": "stems/bass.wav", "name": "bass", "role": "bass", "pan": 0.0})
    if session.backing.arp:
        tracks.append({"file": "stems/arp.wav", "name": "arp", "role": "arp", "pan": 0.0})
    return {
        "tempo": report.beat_bpm,
        "beat_style": report.beat_style,
        "key": report.key,
        "progression": report.progression,
        "lead": session.lead,
        "tracks": tracks,
    }


# ---------------------------------------------------------------------------
# endpoints
# ---------------------------------------------------------------------------

@app.post("/api/session")
def create(body: CreateBody):
    if body.from_band:
        inputs = P._band_wavs(body.from_band)
    else:
        inputs = body.inputs or DEMO
    inputs = [p for p in inputs if os.path.exists(p)]
    if len(inputs) < 2:
        raise HTTPException(400, "need at least two takes")

    parser, parser_name = None, "rule-based"
    has_creds = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    if body.use_llm and has_creds:
        try:
            import llm_parser
            parser = llm_parser.LLMParser()
            parser_name = f"claude ({parser.model})"
        except Exception:
            pass  # fall back silently to rule-based
    elif body.use_llm:
        parser_name = "rule-based (set ANTHROPIC_API_KEY for Claude)"

    sid = uuid.uuid4().hex[:8]
    out_dir = os.path.join(SESSION_ROOT, sid)
    session = P.ProducerSession(inputs, out_dir, lead=body.lead or DEMO_LEAD, parser=parser)
    SESSIONS[sid] = session
    report = session.render()
    return {"id": sid, "parser": parser_name, "project": project_dict(session, report)}


@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...), lead: str = Form(None)):
    """Create a session from the user's own uploaded WAV takes."""
    if len(files) < 2:
        raise HTTPException(400, "upload at least two takes")
    sid = uuid.uuid4().hex[:8]
    up_dir = os.path.join(SESSION_ROOT, sid, "_uploads")
    os.makedirs(up_dir, exist_ok=True)
    paths = []
    for f in files:
        safe = os.path.basename(f.filename or "take.wav").replace("/", "_")
        dest = os.path.join(up_dir, safe)
        with open(dest, "wb") as out:
            out.write(await f.read())
        paths.append(dest)

    has_creds = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    parser, parser_name = None, "rule-based"
    if has_creds:
        try:
            import llm_parser
            parser = llm_parser.LLMParser()
            parser_name = f"claude ({parser.model})"
        except Exception:
            pass

    out_dir = os.path.join(SESSION_ROOT, sid)
    # with no explicit lead, use the longest take as the guide the others align
    # into (same format, so file size tracks duration). best reference for DTW.
    lead_name = lead or os.path.basename(max(paths, key=os.path.getsize))
    try:
        # imported takes: beat-snap placements to the grid + minimal pitch correction
        session = P.ProducerSession(paths, out_dir, lead=lead_name, parser=parser, beat_snap=True, tune=0.5)
        report = session.render()
    except Exception as e:
        raise HTTPException(400, f"couldn't process those takes: {e}")
    SESSIONS[sid] = session
    return {"id": sid, "parser": parser_name, "project": project_dict(session, report)}


def _beat_dict(b: H.BeatConfig) -> dict:
    return dataclasses.asdict(b)


def _backing_dict(bk: H.BackingConfig) -> dict:
    d = dataclasses.asdict(bk)
    if d.get("key") is not None:
        d["key"] = list(d["key"])   # tuple -> JSON list
    return d


@app.get("/api/session/{sid}/bundle")
def bundle(sid: str):
    """Engine half of a project file: source takes (base64) + lead + beat/backing.
    The frontend combines this with its client mix state and downloads it."""
    session = SESSIONS.get(sid)
    if not session:
        raise HTTPException(404, "session not found")
    takes = []
    for p in session.inputs:
        with open(p, "rb") as f:
            takes.append({"name": os.path.basename(p), "data": base64.b64encode(f.read()).decode()})
    return {"lead": session.lead, "beat": _beat_dict(session.beat),
            "backing": _backing_dict(session.backing), "takes": takes}


@app.post("/api/load")
def load(body: LoadBody):
    """Rebuild a session from a saved project's engine half."""
    if len(body.takes) < 2:
        raise HTTPException(400, "a project needs at least two takes")
    sid = uuid.uuid4().hex[:8]
    up_dir = os.path.join(SESSION_ROOT, sid, "_uploads")
    os.makedirs(up_dir, exist_ok=True)
    paths = []
    for tk in body.takes:
        safe = os.path.basename(tk.name).replace("/", "_")
        dest = os.path.join(up_dir, safe)
        with open(dest, "wb") as out:
            out.write(base64.b64decode(tk.data))
        paths.append(dest)

    has_creds = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    parser, parser_name = None, "rule-based"
    if has_creds:
        try:
            import llm_parser
            parser = llm_parser.LLMParser(); parser_name = f"claude ({parser.model})"
        except Exception:
            pass

    out_dir = os.path.join(SESSION_ROOT, sid)
    session = P.ProducerSession(paths, out_dir, lead=body.lead or os.path.basename(paths[0]), parser=parser)
    # restore beat/backing config
    bf = {f.name for f in dataclasses.fields(H.BeatConfig)}
    session.beat = H.BeatConfig(**{k: v for k, v in body.beat.items() if k in bf})
    kf = {f.name for f in dataclasses.fields(H.BackingConfig)}
    bk = {k: v for k, v in body.backing.items() if k in kf}
    if isinstance(bk.get("key"), list):
        bk["key"] = tuple(bk["key"])
    session.backing = H.BackingConfig(**bk)
    SESSIONS[sid] = session
    report = session.render()
    return {"id": sid, "parser": parser_name, "project": project_dict(session, report)}


@app.post("/api/session/{sid}/command")
def command(sid: str, body: CommandBody):
    session = SESSIONS.get(sid)
    if not session:
        raise HTTPException(404, "session not found")
    messages, _ = session.apply(body.text)
    report = session.render()
    return {"messages": messages, "project": project_dict(session, report)}


@app.post("/api/session/{sid}/add_take")
async def add_take(sid: str, file: UploadFile = File(...), name: str = Form(None)):
    """Append a newly recorded (or uploaded) take to a live session and re-balance."""
    session = SESSIONS.get(sid)
    if not session:
        raise HTTPException(404, "session not found")
    up_dir = os.path.join(session.out_dir, "_uploads")
    os.makedirs(up_dir, exist_ok=True)
    safe = os.path.basename(name or file.filename or "recording.wav").replace("/", "_")
    if not safe.lower().endswith(".wav"):
        safe += ".wav"
    dest = os.path.join(up_dir, safe)
    with open(dest, "wb") as out:
        out.write(await file.read())

    base = os.path.basename(dest)
    session.inputs.append(dest)
    session.tracks.append(base)
    session.adj[base] = H.TrackAdjust()
    try:
        report = session.render()
    except Exception as e:
        # roll back a bad take rather than wedging the session
        session.inputs.pop(); session.tracks.pop(); session.adj.pop(base, None)
        raise HTTPException(400, f"couldn't add that take: {e}")
    return {"project": project_dict(session, report)}


@app.post("/api/session/{sid}/remove_take")
def remove_take(sid: str, track: str):
    """Remove a take (vocal track) from a session and re-balance. Keeps ≥2."""
    session = SESSIONS.get(sid)
    if not session:
        raise HTTPException(404, "session not found")
    if track not in session.tracks:
        raise HTTPException(400, "unknown track")
    if len(session.tracks) <= 2:
        raise HTTPException(400, "need at least two takes")
    idx = session.tracks.index(track)
    path = session.inputs[idx]
    session.tracks.pop(idx)
    session.inputs.pop(idx)
    session.adj.pop(track, None)
    if session.lead == track:            # re-point the lead if we removed it
        session.lead = session.tracks[0]
    report = session.render()
    return {"project": project_dict(session, report)}


@app.post("/api/session/{sid}/lead")
def set_lead(sid: str, track: str):
    session = SESSIONS.get(sid)
    if not session:
        raise HTTPException(404, "session not found")
    if track not in session.tracks:
        raise HTTPException(400, "unknown track")
    session.lead = track
    report = session.render()
    return {"project": project_dict(session, report)}


@app.post("/api/session/{sid}/align")
def realign(sid: str, beat_snap: bool = True, div: float = 1.0, tune: float = 0.5, grid_ref: str = "", phase: float = -1.0):
    """Re-run placement/tuning with the user's chosen beat-snap resolution
    (div in beats: 4=bar, 1=beat, 0.5=eighth), pitch-correction amount, and an
    optional timing-reference track (grid_ref) whose tempo+downbeat set the grid."""
    session = SESSIONS.get(sid)
    if not session:
        raise HTTPException(404, "session not found")
    if grid_ref and grid_ref not in session.tracks:
        raise HTTPException(400, "unknown timing reference track")
    session.set_align(beat_snap, div, tune, grid_ref or None, phase if phase >= 0 else None)
    report = session.render()
    return {"project": project_dict(session, report)}


@app.get("/api/session/{sid}/file")
def file(sid: str, path: str):
    session = SESSIONS.get(sid)
    if not session:
        raise HTTPException(404, "session not found")
    # confine to the session's output directory
    full = os.path.normpath(os.path.join(session.out_dir, path))
    if not full.startswith(os.path.abspath(session.out_dir)) or not os.path.exists(full):
        raise HTTPException(404, "file not found")
    return FileResponse(full, media_type="audio/wav")


@app.get("/api/session/{sid}/mix")
def mix(sid: str):
    session = SESSIONS.get(sid)
    if not session:
        raise HTTPException(404, "session not found")
    path = os.path.join(session.out_dir, "preview_mix.wav")
    return FileResponse(path, media_type="audio/wav", filename="deejai_mix.wav")


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.server:app", host="127.0.0.1", port=8000, reload=False)
