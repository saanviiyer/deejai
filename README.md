# deejai — harmony balancer

First feature: take several raw vocal takes (a lead plus one or more harmony
parts) and do the balancing pass a producer would do by hand, so the parts
blend. Then hand the results off to GarageBand.

## Why it works this way

GarageBand has no automation API, so nothing here reaches into a live
GarageBand session. The flow is files in, files out:

1. Record your takes in GarageBand (or anywhere), export each as WAV.
2. Run the balancer on them.
3. Drag the processed stems back into GarageBand and keep editing by hand.

The heavy lifting (loudness, timing, EQ, stereo placement) is pure audio
processing and doesn't need a DAW to run.

## What the balancing pass does

- **timing alignment** — cross-correlates each harmony against the lead and
  shifts it into place (bounded to ±120 ms so a bad match can't run wild)
- **loudness matching** — measures each take's LUFS, sets the lead at a target
  and tucks the harmonies a few LU below it
- **masking-aware EQ** — high-passes the harmonies so their low end stops
  muddying the lead
- **stereo placement** — keeps the lead centered and spreads the harmonies
  left and right

## Run it

```bash
# make three synthetic test takes and balance them
python3 make_demo.py
python3 harmony.py demo_takes/lead.wav demo_takes/harmony_third.wav demo_takes/harmony_fifth.wav -o demo_out --lead lead.wav
```

On your own recordings:

```bash
python3 harmony.py lead.wav harm1.wav harm2.wav -o my_out --lead lead.wav
```

Options: `--lead-lufs` (lead target loudness), `--harmony-offset` (how far
under the lead the harmonies sit), `--spread` (stereo width, 0..1),
`--no-align` (skip timing correction).

## Output

- `stems/` — one processed WAV per take, level + EQ + timing already applied,
  ready to drag into GarageBand
- `preview_mix.wav` — everything summed and panned so you can hear the result now
- `report.json` — every decision (measured LUFS, gain applied, offset corrected,
  HPF, recommended pan) so you can reproduce it by hand in GarageBand

## Getting the result into GarageBand

There's no direct API into GarageBand (it exposes no automation), so the handoff
is drag-and-drop, but deejai makes finding the files one step:

1. In the producer prompt, type `reveal` (aliases: `show`, `open`, `stems`). It
   opens the session's `stems/` folder in Finder.
2. Drag the WAVs from that folder onto GarageBand's track area. Each becomes its
   own audio track: `lead_*`, `harmony_*`, and any `synth_pad.wav` / `bass.wav` /
   `beat.wav` / `arp.wav` you added.

The output folder's absolute path is printed at startup, and `preview_mix.wav`
(next to `stems/`) is the full mix if you'd rather import one file.

**Tempo tip.** The beat and backing are locked to the tempo deejai detected from
the vocal (printed as `[beat ~132 BPM]`), which is usually *not* GarageBand's
project tempo. So the grid will line up, set GarageBand's tempo to that number.
When you drag the WAVs in, leave "Follow Tempo & Pitch" **off** for those regions
so GarageBand doesn't time-stretch them away from the tempo they were built at.

## Talking to the mix (producer)

Instead of the CLI flags, drive the balance in plain language:

```bash
python3 producer.py doyou_takes/mid.wav doyou_takes/low.wav "doyou_takes/super high.wav" --lead mid.wav -o my_session
```

Then type requests at the `>` prompt ("the low part is too loud", "make the
harmonies wider", "more air on the top", "add some space", "undo", "reset").
Each request re-renders `my_session/preview_mix.wav`.

Two parsers turn a sentence into edits, and they share the same output shape so
the session and engine don't care which one runs:

- **rule-based (default)** — keyword matching, runs offline, no key. Finite
  vocabulary: a phrase it doesn't know gets "didn't catch that" with examples.
- **Claude (`--llm`)** — understands arbitrary phrasing ("the bottom voice is
  swallowing the melody"). Claude classifies the intent; the same step sizes
  the rule-based parser uses set the actual amounts, so the two stay consistent.

```bash
python3 producer.py <takes> --lead mid.wav -o my_session --llm
```

### Hearing the result

The preview re-renders to `<out>/preview_mix.wav` after every request. To hear
it, type `play` at the prompt (macOS plays it inline; elsewhere it opens in your
default player), or pass `--play` to auto-play after each change.

### A beat that fits the vocal

Ask for "add a beat" and deejai extracts the vocal's tempo, brightness, and
energy, then **retrieves the style that fits** (lofi, boom-bap, four-on-the-floor,
trap, ballad, pop) and sequences a drum kit of real one-shots at that tempo,
humanized (swing, velocity, ghost notes) and downbeat-aligned to the vocal. Name
a style to force it ("add a lofi beat", "trap beat", "boom bap"), or a tempo
("add a beat at 90 bpm"). "no beat" removes it.

Kits and patterns live in [drumkit.py](drumkit.py) and [patterns.py](patterns.py);
retrieval is `patterns.choose_beat`. The drum one-shots are synthesized and cached
under `kits/<name>/`; to use a commercial sample pack instead, drop WAVs named
kick/snare/hat_closed/hat_open/clap/rim into a kit folder and they load in place.
The beat is written as its own stem (`stems/beat.wav`). Tempo/key detection on a
cappella vocals is approximate, so name a BPM or style if a guess is off.

Run `python3 tests.py` to validate the whole system (17 checks, ~30s).

### Synth, chords, and backing tracks

Ask for harmonic backing and deejai detects the **key** of the lead vocal (so the
chords are in tune with the singing) and the tempo, then synthesizes instruments
in that key:

- "add a synth pad" / "add chords" — a pad playing the chord progression
- "add a bassline" — bass on the chord roots
- "add an arpeggio" — an arp climbing each chord
- "add a backing track" / "add an instrumental" — a pad + bass bed

Change the feel with "make it a sad progression" (also `pop`, `50s`, `ballad`),
or pin the key with "put it in A minor" if the auto-detected one is off. "no
synth" / "no bass" removes an element. Each instrument writes its own stem
(`synth_pad.wav`, `bass.wav`, `arp.wav`) so you can drag them into GarageBand
separately.

Key and tempo come from the vocal, not GarageBand, so the backing lines up with
what was actually sung. Key detection on a short a cappella take is approximate,
so name the key if it guesses wrong.

### Working on every take in a project

Instead of listing files, point at a GarageBand bundle to load all its recorded
takes at once:

```bash
python3 producer.py --from-band ~/Music/GarageBand/"do you<3.band" --lead "New Recording 457.wav" -o my_session
```

Not every take in a project is a harmony layer (some are long lead or scratch
takes), so pick the `--lead` deliberately; the rest are balanced as harmonies
around it.

The `--llm` path needs the `anthropic` package and Claude credentials
(`ANTHROPIC_API_KEY`, or an `ant auth login` profile). Without either, it prints
a note and falls back to the rule-based parser. Model is `claude-opus-5` in
[llm_parser.py](llm_parser.py:34); switch it to `claude-haiku-4-5` there for a
faster, cheaper parse.

## Requirements

Python 3, `numpy`, `scipy`, `soundfile`, `pyloudnorm`.

```bash
pip3 install numpy scipy soundfile pyloudnorm
```

For the `--llm` parser, also `anthropic`:

```bash
pip3 install anthropic
```
