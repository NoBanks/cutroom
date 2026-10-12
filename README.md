# CUTROOM

**Your first cut, tonight.**

CUTROOM is a virtual cutting room. You hand it raw footage and one line of intent.
A crew of AI agents watches every clip, commits to a point of view, cuts against it,
**builds a real Shotcut timeline by calling MCP tools**, screens the result, fixes it
once, and tells you what to shoot tomorrow.

You get back a rendered rough cut, a `.mlt` project that opens in Shotcut so you can
keep cutting, the edit decision list with the reason behind every cut, the reviewer's
notes, and a pickup call sheet.

It does not replace an editor. It replaces the empty timeline.

Built by a cinematographer with 30 years behind the camera, for the
Nebius x NVIDIA Global AI Hackathon (Best Apps and Agents).

---

## The crew

| Chair | Job | Model (on Nebius Token Factory) |
|---|---|---|
| **RESEARCH** | Decides what is worth looking up (platform delivery specs, genre conventions) and searches the web | NVIDIA Nemotron 3 Nano + **Tavily** |
| **DIRECTOR** | Turns one line of intent into an editorial point of view: pacing, target length, shot band, opening and closing, what to look for | **NVIDIA Nemotron 3 Super** (reasoning on) |
| **SELECTOR** | Watches every clip as timecoded contact sheets plus a motion and loudness profile, logs every usable moment and every dead shot | GLM-5.3-Flash (vision) |
| **EDITOR** | Sequences the cut under the Director's laws; every row says why the cut exists | **NVIDIA Nemotron 3 Super** (reasoning on) |
| **ASSISTANT EDITOR** | Conforms the EDL into a Shotcut timeline **by calling shotcut-mcp tools itself**, checks its work, applies the Reviewer's orders the same way | **NVIDIA Nemotron 3 Nano** (tool calling) |
| **REVIEWER** | A screener watches the rendered cut; the Reviewer decides "ship" or one bounded pass of machine-executable orders | GLM-5.3-Flash eyes, **Nemotron 3 Super** verdict |
| **COVERAGE** | Tells the shooter what the cut is missing, as a call sheet | **NVIDIA Nemotron 3 Nano** |

Every decision is made by an NVIDIA Nemotron model. The vision model is the crew's
eyes only: Token Factory hosts no NVIDIA vision model today, so footage is described
by GLM-5.3-Flash and judged by Nemotron.

## How the agents touch the timeline (MCP)

The Assistant Editor is a Nemotron tool-calling loop over
[shotcut-mcp](https://github.com/NoBanks/shotcut-mcp), an MCP server that edits
Shotcut/MLT projects headlessly: `create_project`, `add_clip`, `trim_clip`,
`move_clip`, `remove_clip`, `split_clip`, `set_transition`, `append_text_overlay`,
`apply_filter`, `get_timeline`, `render`.

Agents decide, code verifies:

- every `get_timeline` result carries an `edl_check` computed by the cutting room, so
  the agent acts on facts, not on its own reading of the timeline;
- after the loop, code compares the timeline to the EDL frame by frame; if it does not
  match, code conforms it and the log says so. The cut is never left wrong;
- the render is `melt` through the MCP `render` tool.

## How the crew watches footage

A vision model cannot play video, so the Selector shows it footage the way an
assistant editor scans dailies: contact sheets of frames sampled evenly through each
clip, each stamped with its source timecode, plus two ffmpeg measurements a still frame
cannot show: picture change and loudness per half second. Back-to-back moments of one
continuous take are joined, because the Editor may trim a moment but never extend one.

## Cost control (built in, not bolted on)

Every model call goes through `lib/spend-guard.js`:

- each call is priced at its **worst case** (all prompt tokens plus the full
  `max_tokens`) **before** it is sent, and refused if that could cross the stop;
- the stop defaults to $20; a hard ceiling of $24 cannot be lifted by any setting;
- retries are checked again every time; failed connections are charged at worst case
  so the ledger never under-counts;
- the public demo adds a daily budget and a one-at-a-time queue.

A typical cut of three short clips costs **about $0.05** in model usage.

## What changed during the hackathon

CUTROOM v1 was a Gemini-only pipeline that cut with ffmpeg. For this hackathon it was
rebuilt (August 26 to October 30, 2026):

- every reasoning and tool-use step moved to **NVIDIA Nemotron on Nebius Token Factory**;
- new **Assistant Editor** that drives a real NLE timeline over **MCP** (the v1 crew
  never touched an editor);
- **shotcut-mcp** repaired so agents can actually use it: state now survives between
  tool calls, crossfades and titles render, real clip durations, new
  `get_timeline`/`trim_clip`/`move_clip`/`remove_clip` tools, real-render tests;
- the Selector and Reviewer now watch through contact sheets and motion/loudness
  profiles instead of a proprietary video API;
- new **Tavily** research step; new spend guard; new web app; streaming model calls.

## Run it

Requirements: Linux (or WSL), Node 22, `melt`, `ffmpeg`, Python 3.10+.

```bash
# 1. the MCP server the Assistant Editor drives
python3 -m venv /opt/shotcut-venv
/opt/shotcut-venv/bin/pip install "git+https://github.com/NoBanks/shotcut-mcp.git@main"

# 2. CUTROOM
npm ci
export NEBIUS_API_KEY=...            # Nebius Token Factory
export TAVILY_API_KEY=...            # optional, enables the research step
export SHOTCUT_MCP_CMD=/opt/shotcut-venv/bin/shotcut-mcp
node server.js                       # http://localhost:8080
```

Or with Docker:

```bash
docker build -t cutroom .
docker run -p 8080:8080 -e NEBIUS_API_KEY=... -e TAVILY_API_KEY=... -v cutroom-data:/data cutroom
```

From the command line:

```bash
node scripts/cut.mjs --brief "A 20 second teaser for the print. Quiet, patient." --out ./run clip1.mp4 clip2.mp4
```

Tests: `npm test` (spend guard, streaming parser, model client, selector).

## Files a cut produces

| File | What it is |
|---|---|
| `roughcut.mp4` | the final cut (after the review pass) |
| `roughcut_v1.mp4` | the first cut, before review |
| `timeline/roughcut.mlt` | the Shotcut project; download from the app with paths made relative |
| `edl.json`, `edl_final.json` | the edit decision lists, with roles and the reason for each cut |
| `research.json` | what the researcher looked up on Tavily, with sources |
| `review.json` | the screener's notes, the verdict and the orders |
| `conform.json` | every MCP tool call the Assistant Editor made |
| `coverage.json`, `pickups.txt` | the gaps and the pickup call sheet |

## License

MIT
