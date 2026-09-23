# deejai

deejai balances raw vocal takes (a lead plus one or more harmony parts) so they blend, like a producer does by hand. You can then ask for changes in plain language, add a beat or backing that fits the vocal, and move the result into GarageBand. A browser DAW in `app/` uses the same engine.

## How it works

GarageBand has no automation API, so deejai does not connect to a live GarageBand session. It reads WAV files and writes WAV files:

1. Record your takes in GarageBand (or any other app) and export each one as WAV.
2. Run the balancer on the takes.
3. Drag the processed stems back into GarageBand and keep editing by hand.

The balancing pass is pure audio processing and needs no DAW:

- Timing alignment: cross-correlates each harmony with the lead and shifts it into place. The shift is limited to ±120 ms, so a bad match cannot move a take far.
- Loudness matching: measures the LUFS of each take, sets the lead at a target level, and puts the harmonies a few LU below it.
- Masking-aware EQ: high-passes the harmonies so their low end does not muddy the lead.
- Stereo placement: keeps the lead in the center and spreads the harmonies left and right.

## Run it

```bash
git clone https://github.com/saanviiyer/deejai
cd deejai
pip3 install numpy scipy soundfile pyloudnorm
pip3 install anthropic          # optional, for --llm
pip3 install fastapi uvicorn    # optional, for the web app
```

Make three synthetic test takes and balance them:

```bash
python3 make_demo.py
python3 harmony.py demo_takes/lead.wav demo_takes/harmony_third.wav demo_takes/harmony_fifth.wav -o demo_out --lead lead.wav
```

On your own recordings:

```bash
python3 harmony.py lead.wav harm1.wav harm2.wav -o my_out --lead lead.wav
```

Options:

- `--lead-lufs`: target loudness of the lead
- `--harmony-offset`: how far below the lead the harmonies sit
- `--spread`: stereo width, 0 to 1
- `--no-align`: skip timing correction

Run the test suite (17 checks, about 30 s, no network):

```bash
python3 tests.py
```

### Output

- `stems/`: one processed WAV for each take, with level, EQ and timing applied
- `preview_mix.wav`: all takes summed and panned
- `report.json`: each decision (measured LUFS, gain, timing offset, HPF, recommended pan), so you can repeat it by hand in GarageBand

## Producer: talk to the mix

```bash
python3 producer.py lead.wav low.wav high.wav --lead lead.wav -o my_session
```

Type requests at the `>` prompt, for example "the low part is too loud", "make the harmonies wider", "more air on the top", "add some space", "undo" or "reset". Each request renders `my_session/preview_mix.wav` again. Type `play` to hear it (macOS plays it inline, other systems open the default player). Use `--play` to play it after each change.

Two parsers turn a sentence into edits. Both give the same output shape.

- Rule-based (default): keyword matching, offline, no key. The vocabulary is fixed. For an unknown phrase it says "didn't catch that" and shows examples.
- Claude (`--llm`): understands free phrasing, such as "the bottom voice is swallowing the melody". Claude classifies the intent. The step sizes of the rule-based parser set the amounts, so the two parsers stay consistent. The model is `claude-opus-5` in `llm_parser.py`. You can change it there to `claude-haiku-4-5` for a faster, cheaper parse. Without credentials, deejai prints a note and uses the rule-based parser.

To load all recorded takes from a GarageBand project, give the `.band` bundle:

```bash
python3 producer.py --from-band "path/to/song.band" --lead "New Recording 457.wav" -o my_session
```

Some takes in a project are long lead or scratch takes and are not harmony layers. Choose `--lead` with care. deejai balances all other takes as harmonies around it.

### Beats

Ask for "add a beat". deejai measures the tempo, brightness and energy of the vocal and picks a style that fits (lofi, boom-bap, four-on-the-floor, trap, ballad, pop). It then sequences a drum kit of one-shots at that tempo, with swing, velocity changes and ghost notes, and aligns the downbeat to the vocal. You can name a style ("add a lofi beat", "trap beat", "boom bap") or a tempo ("add a beat at 90 bpm"). "no beat" removes it.

Kits are in `drumkit.py` and patterns are in `patterns.py`. `patterns.choose_beat` picks the style. `drumkit.py` synthesizes the drum one-shots and caches them under `kits/<name>/`. To use a commercial sample pack, put WAVs named kick, snare, hat_closed, hat_open, clap and rim into a kit folder. The beat is its own stem (`stems/beat.wav`). Tempo detection on a cappella vocals is approximate, so name a BPM or style if the guess is wrong.

### Synth, chords and backing

deejai detects the key and tempo of the lead vocal and synthesizes instruments in that key:

- "add a synth pad" or "add chords": a pad that plays the chord progression
- "add a bassline": bass on the chord roots
- "add an arpeggio": an arp that climbs each chord
- "add a backing track" or "add an instrumental": a pad and bass bed

Change the feel with "make it a sad progression" (also `pop`, `50s`, `ballad`). Set the key with "put it in A minor" if the detected key is wrong. "no synth" or "no bass" removes an element. Each instrument writes its own stem (`synth_pad.wav`, `bass.wav`, `arp.wav`). Key and tempo come from the vocal, so the backing matches what was sung. Key detection on a short a cappella take is approximate.

### Into GarageBand

1. At the producer prompt, type `reveal` (or `show`, `open`, `stems`). This opens the `stems/` folder of the session in Finder. deejai also prints the absolute output path at startup.
2. Drag the WAVs onto the GarageBand track area. Each file becomes its own audio track: `lead_*`, `harmony_*`, and any `synth_pad.wav`, `bass.wav`, `beat.wav` or `arp.wav` you added. To import one file, use `preview_mix.wav`.

The beat and backing use the tempo that deejai detected from the vocal (printed as `[beat ~132 BPM]`). This is usually different from the GarageBand project tempo. Set the GarageBand tempo to that number so the grid lines up. Turn "Follow Tempo & Pitch" off for these regions, so GarageBand does not time-stretch them.

## Web app

`app/` is a GarageBand-style multitrack DAW in the browser with the producer built in. See [app/README.md](app/README.md).

```bash
python3 -m uvicorn app.server:app --port 8000
```

Open http://localhost:8000.

## Environment variables

Both are optional. Set one of them to use Claude for the `--llm` parser and the web app producer. Without them, deejai uses the offline rule-based parser. An `ant auth login` profile also works for the CLI.

| Name | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude API key |
| `ANTHROPIC_AUTH_TOKEN` | Claude auth token (read by `app/server.py`) |

## Layout

```
harmony.py        balancing pass (CLI)
producer.py       plain-language producer session (CLI)
llm_parser.py     Claude parser for --llm
agent.py          agent loop: analyze the mix, act through tools, repeat (needs Claude)
analysis.py       mix analysis: LUFS, peaks, masking, clipping flags
align.py          content-aware take alignment
patterns.py       beat patterns, style choice and sequencer
drumkit.py        synthesized drum kits, cached under kits/
make_demo.py      synthetic test takes
render_blend.py   render script for one local GarageBand project
tests.py          end-to-end test suite
app/              web DAW (server.py plus static/)
```

## Not in the repo

Audio files (`.wav` and other audio formats), session and demo output folders, and backups are not committed. The drum kit cache `kits/` is also left out, because `drumkit.py` makes it again.
