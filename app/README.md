# deejai DAW (web app)

A GarageBand-style multitrack in the browser with the agentic producer built in.
No drag-to-GarageBand: load vocals, see tracks, talk to it, play, export.

## Run

```bash
cd /Users/saanviiyer/Downloads/CALTECH/deejai
python3 -m uvicorn app.server:app --port 8000
```

Then open http://localhost:8000

For the plain-language producer to understand any phrasing (not just the keyword
set), set a key before launching; otherwise it uses the offline rule-based parser
and says so:

```bash
export ANTHROPIC_API_KEY=your-key-here
```

## What it does

- **Record in-app**: "● rec" opens your mic and plays the current mix so you
  overdub in time; stop, and the take is added, balanced, and onset-synced with
  the rest. Use headphones so the mic doesn't pick up the mix.
- **Record-arm (R) + input monitoring (◎ mon)**: the **R** on a track head arms
  it (one at a time). Arm a software-instrument track and your keys/MIDI record
  into it no matter which track is selected; arm a vocal/audio track and **● rec**
  overdubs a new **comp take** onto that track (split a region and tap **T** to
  comp) instead of making a new track. **◎ mon** turns on input monitoring so you
  hear the mic live through the armed track's channel strip (EQ, reverb, etc.) —
  headphones required.
- **Import your own takes**: "import takes", or drag WAVs onto the track area.
  Upload as many recordings as you like at once. deejai **positions each one
  where it fits** rather than forcing them all to start together — a take that
  comes in later lands later on the timeline, and one whose content starts early
  has its lead-in trimmed, so the entrances line up while the start times vary.
  You can still drag any region to reposition it. Starts on demo takes so there's
  always something to hear.
- **Tracks**: each take (and each added instrument) is a lane with a waveform,
  volume (dB-labeled), pan, mute, solo, and a lead star (click to re-balance
  around a different lead). Pans start where deejai placed them.
- **Drag-to-move regions**: grab a track's waveform and slide it left/right to
  shift its timing (1:1 with the cursor, snaps to the grid near zero), on top of
  the automatic onset sync. The ‹ / › buttons still do fine 10 ms steps. Moving a
  region reschedules playback and is included in the export.
- **Align & tune** (the **align** button): re-positions your takes by matching
  content, then snaps each entry to a grid you choose — **bar · downbeat**, beat,
  ½ beat, or off. Use **bar · downbeat** when a take comes in on the wrong beat
  (e.g. the 2 instead of the 1). Set a **timing reference** track (e.g. a guitar
  backing you imported) and its tempo and downbeat become the grid the vocals
  snap to — the reference itself stays put and un-tuned. If the detected downbeat
  is wrong, hit **set on ruler** and click the ruler where beat 1 is (a green "1"
  marker appears); that overrides detection. The **pitch correct** slider applies
  minimal, transparent tuning (only notes meaningfully off). It re-runs on your
  original takes, so it's non-destructive.
- **Vocal blend bus** (Smart Controls, "vocal blend"): every lead/harmony take
  runs through one shared bus so a stack of voices sits together. **space** is a
  single shared reverb for all the voices, **glue** is bus compression so they
  move as one, and **air** adds a high shelf. **auto** sets tasteful amounts and
  spreads the harmonies across the stereo field. It works for any number of takes
  — import all your harmonies and they blend together.
- **Smart Controls strip** (bottom): click a track to select it, then adjust its
  live **3-band channel EQ** (low shelf / mid peak / high shelf) and **reverb
  send** while it plays. These are real Web Audio nodes, so changes are instant
  and folded into the export. Volume and pan mirror the track head. Reverb is a
  shared bus (per-track send → convolver), like a DAW.
- **Producer panel**: type a request or hit a chip. Every request re-renders and
  the tracks update — "add a simple beat", "the low part is too loud", "make it a
  sad progression". Beat and backing lock to the vocal's own tempo and key.
- **Transport**: play/stop (or spacebar), loop, and click the ruler to play from
  a point. Everything runs in sync through a live Web Audio graph, so faders, pan,
  and nudge move the mix while it plays.
- **Timeline zoom + grid + snap**: −/+/fit zoom the timeline (horizontal scroll,
  track heads stay pinned). The ruler shows a grid — bars/beats once a beat sets
  the tempo, seconds otherwise. With snap on, dragging a region lands on the grid
  (exact beats with a tempo, 1 s without).
- **Region editing**: grab a region's left/right edge to trim it, or its top
  corners to draw fade-in/out (shown as triangles, applied in playback + export).
- **Undo/redo**: ↶ ↷ or ⌘Z / ⌘⇧Z, covering every mixer and region edit. (Chat
  commands are structural and reset the undo baseline.)
- **Remove a take**: the × on a vocal track head; the rest re-balance (keeps ≥2).
- **Effects rack** (Smart Controls, per track, all live + in export): 3-band EQ,
  dynamics (compressor + drive/saturation), reverb send, and a delay/echo
  (time + feedback + mix). Flat/off by default.
- **Bounce / flatten**: the **⤓** on a software-instrument track renders it
  through its channel strip to a real **audio track** you can trim, fade, split,
  comp, and re-pitch like any recording. The original instrument stays, so it's
  non-destructive. (Bounced audio lives in the session and undo; save/load keeps
  the source instrument, not the rendered audio.)
- **Tempo track**: the **tempo** button opens a lane above the tracks. Click to
  add a tempo point, drag it to change the BPM or move it, alt/right-click to
  remove. The whole beat grid, snapping, metronome, and the Drummer follow the
  tempo changes (a song that speeds up or slows down gets a grid that matches).
  Saved with the project.
- **Drummer**: the **🥁 drummer** button generates a full drum performance across
  the song in a chosen style (pop / rock / lofi / trap / house / funk / disco)
  and intensity, with a fill every few bars. It lands as a drums instrument
  track, so you can open its piano roll to edit hits, swap the kit, or arpeggiate.
- **Software instruments + MIDI**: "+ inst" adds a synth track (synth / keys /
  bass / pluck). Its lane opens a **piano roll** — click to add notes, drag to
  move, drag the right edge to resize, select + Delete to remove, all on a
  tempo-snapped grid. The **score** button switches to an editable **notation
  view**: a grand staff (treble + bass clef) with the track's notes as
  note-value glyphs, accidentals, ledger lines, and bar lines from the tempo grid.
  It reads the **key signature** off the song key (sharps/flats drawn after the
  clefs) and spells accordingly, so a note that belongs to the key prints with no
  accidental and one that leaves it gets a sharp, flat, or natural. Accidentals
  are **bar-scoped** the way engravers write them: the symbol prints once, a
  repeat of the same altered note in the bar stays bare, a return to the natural
  gets a ♮, and every bar line resets the state. A note that was altered in the
  previous bar gets a **courtesy accidental** (dim, in parentheses) when it
  returns to its key spelling in the next bar. Held notes
  show **dotted** values, and a note that runs across a bar line is split into
  **tied** noteheads joined by a slur. Consecutive eighths and sixteenths inside
  the same beat are **beamed** together (a second beam, or a stub, for the
  sixteenths) instead of each carrying a flag, and the beam **slants to follow
  the melody** (a least-squares fit through the noteheads, capped so wide leaps
  stay readable, flat when the outer notes share a pitch, and snapped to the
  staff grid). Click the staff to add a note at that pitch
  and beat, drag a note to move it, select and Delete to remove. **↑/↓** nudge the
  selected note a semitone (so a natural becomes a sharp), the **♭** button
  respells a black-key note as a flat, and rests fill the empty beats between
  notes. Play notes live from your **computer keyboard** (A–K, Z/X
  shift octave) or a **MIDI keyboard** (Web MIDI); with the transport rolling,
  what you play is **recorded** into the selected instrument. Instrument notes
  run through the same channel strip + effects and are in the export.
- **Automation lanes**: the **A** button on a track cycles its lane through
  volume / pan / reverb-send automation. Click the lane to add points, drag to
  move them, alt/right-click to delete. The curve plays back as smooth parameter
  ramps and is rendered in the export. Captured by undo and save.
- **Save / open**: "save" downloads a `.deejai.json` (source takes + engine
  config + full mixer/effects state + instrument tracks and their notes + your
  align/tune settings); "open" restores the whole project into a fresh session —
  mix, effects, instruments, and the alignment (snap resolution, timing
  reference, manual downbeat, and pitch-correction amount) are re-applied, so the
  placements and tuned audio come back exactly as you left them. Bounced-audio
  tracks and comp takes are embedded in the file too (gzip-compressed losslessly
  — a drum bounce shrinks ~4x), so they survive a reopen.
- **Take comping**: ⊕T on a vocal track pulls your other takes in as alternate
  lanes; split a region (✂) and tap **T** to choose the best take for each
  section. Each region shows which take (T1/T2…) it plays.
- **Loop / sound browser**: the **loops** button opens a library of 41 built-in
  loops across drums, bass, chords, pads, arps, and melodies. ▸ previews, **+**
  drops one at the playhead, or drag it onto the timeline. Loops lock to the
  project tempo.
- **Software instruments**: synth, keys, bass, pluck, **FM**, **drums** (a synth
  kit), and a **sampler** (plays a built-in mallet or any WAV you load,
  chromatically). Pick the instrument in the piano roll.
- **More effects** (per track): the bitcrusher (**crush**) and a **mod** section
  (chorus↔flanger) join the EQ, compressor, drive, reverb, and delay.
- **Metering**: every track head and the master show a live level meter with
  peak-hold.
- **Metronome + count-in + time signature**: **click** toggles the metronome,
  **count-in** gives you a bar before recording, and you set **bpm** and a full
  **time signature** — numerator **and** denominator (e.g. 6/8, 3/4, 5/8). The beat
  grid, snap, metronome, and count-in all follow the denominator, so an x/8 meter
  counts in eighth-note beats. The score prints the time signature after the key
  signature, and in a compound meter (6/8, 9/8, 12/8) it **beams in threes**.
  Saved with the project and captured by undo.
- **Editing**: ⌘C / ⌘X / ⌘V copy, cut, and paste a region at the playhead;
  Delete removes the selected region; drag the **⋮⋮** handle to reorder tracks;
  **⟳** loop-repeats a region to fill the space after it.
- **MIDI quantize + transpose**: in the piano roll, **apply** snaps notes to a
  1/4, 1/8, or 1/16 grid with strength and swing, and the transpose buttons shift
  an instrument track by semitones or octaves (playback and export follow).
- **On-screen keyboard**: a playable piano at the bottom of the piano roll —
  click keys to audition the instrument, and while the transport rolls your
  playing is recorded (alongside the A–K computer keys and any MIDI keyboard).
- **Region gain + note velocity**: alt-drag a region up/down to change its gain
  (shown as a dB tag), or alt-drag a note in the piano roll to set its velocity.
- **Vocal pitch correction (beta)**: select a vocal, then **tune** in the pitch
  section of the Smart Controls nudges it toward the nearest notes. It is
  non-destructive — a "tuned" take is added, and the **T** button A/Bs it against
  your original.
- **Rename + recolor**: double-click a software-instrument track's name to rename
  it; click its colored dot to cycle through track colors.
- **Master bus**: low/high EQ, a glue compressor, and a brickwall limiter on the
  output (in the Smart Controls, folded into the export).
- **Cycle + markers**: shift-drag the ruler to set a cycle region and hit
  **cycle** to loop it; **⚑** drops an arrangement marker at the playhead
  (right-click a marker to remove it).
- **Arpeggiator**: the **arp** control in the piano roll turns chords on an
  instrument track into up / down / up-down patterns at a chosen rate (playback
  and export follow; off by default).
- **Export**: **export wav** renders the graph **exactly as you hear it** — your
  volume, pan, mute/solo, nudge, effects, and master bus included — to a WAV in
  the browser. **share** renders the same mix to a small compressed file
  (webm/opus, or m4a in Safari) for sending.

## How it's wired

- `server.py` — FastAPI. Holds one `ProducerSession` per browser session and
  exposes it: create, command, serve stems, export. The audio engine
  (`harmony.py`, `producer.py`, `llm_parser.py` one dir up) is unchanged.
- `static/` — the DAW: `app.js` is the Web Audio engine (decode stems, per-track
  gain/pan/mute/solo, transport, waveforms) plus the chat that drives the backend.

## Not yet (roadmap)

Per-instrument (beat/pad/bass) level from the mixer, undo across the whole
session, and project save/load. (The chat's "more air"/"add space" macros still
bake into stems on the Python side; the Smart Controls EQ/reverb are separate
live channel-strip controls that stack on top — flat by default.)
