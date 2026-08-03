# ask-chatgpt

[![skills.sh](https://skills.sh/b/JuliusJu572/ask-chatgpt-skill)](https://skills.sh/JuliusJu572/ask-chatgpt-skill)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Give your AI agent (Claude Code, opencode, …) the ability to **ask ChatGPT** —
with ChatGPT's own **live web search and deep reasoning** — through your **real,
logged-in Chrome session**. No API key needed; it reuses your existing ChatGPT
login.

Reach for it when your agent is stuck on a bug, needs current facts (latest
versions, release notes, CVEs), needs to **research and synthesize a lot of web
material**, or wants a **second opinion** from another strong model.

```bash
node chatgpt.mjs ask "Search the web: what's the latest stable Node.js LTS?"
```

## Install

With the [skills.sh](https://skills.sh) CLI (works with Claude Code, opencode,
Cursor, Codex, and many other agents):

```bash
npx skills add JuliusJu572/ask-chatgpt-skill
```

Or manually:

```bash
# Claude Code
git clone https://github.com/JuliusJu572/ask-chatgpt-skill ~/.claude/skills/ask-chatgpt
cd ~/.claude/skills/ask-chatgpt && npm install

# opencode
git clone https://github.com/JuliusJu572/ask-chatgpt-skill ~/.config/opencode/skills/ask-chatgpt
cd ~/.config/opencode/skills/ask-chatgpt && npm install
```

## One-time setup

```bash
node chatgpt.mjs sync     # copy ChatGPT login cookies from your everyday Chrome
node chatgpt.mjs status   # -> "OK: logged in"
```

`sync` copies the ChatGPT session cookies from `~/.config/google-chrome` into an
isolated profile (`~/.ask-chatgpt/profile`). Your daily Chrome can stay open —
files are copied, the directory is not shared, and cookies never leave your
machine.

Login in a non-default Chrome profile? `ASK_CHATGPT_CHROME_PROFILE="Profile 1"
node chatgpt.mjs sync`. Or just `node chatgpt.mjs login` once, manually.

## Usage

```bash
S=~/.claude/skills/ask-chatgpt/chatgpt.mjs   # or your install path

# single question (stdout = clean answer)
node $S ask "Search the web: current LTS version of Node.js?"

# multi-turn: named sessions keep full context across separate calls
node $S ask "Debugging this Rust borrow error: ..." -s rustbug
node $S ask "Your fix gave E0502 instead — why?" -s rustbug   # remembers

node $S sessions          # list named sessions
node $S stop              # close the background browser
```

### Key behaviors

- **Deep research takes minutes.** "Thinking" / research answers routinely run
  7–8 minutes. Default timeout is 15 min; a long pause is not a failure.
- **Partial answers are impossible to mistake.** If the timeout is hit, stdout
  starts with `[INCOMPLETE ANSWER — …]` and the exit code is **3** (`0` = done,
  `1` = error). Don't treat a partial answer as final.
- **Requests are minimal.** Completion is detected by watching the page (free),
  and each answer costs ~**one** backend request; a 429 rate-limit triggers a
  backoff, never a reload.
- **Serialize asks.** One shared login / one browser tab: run one question at a
  time, even across agents.

## Requirements

- Linux with a desktop session (Chrome needs a display; headless is blocked by
  Cloudflare)
- Google Chrome installed and logged in to ChatGPT
- Node.js ≥ 18

## How it works

A background daemon keeps one logged-in Chrome open. The page itself (via
ChatGPT's own stream) decides *when* an answer is done; exactly one call to
`/backend-api/conversation/<id>` then fetches the finished answer as clean
markdown. Follow-ups wait for any in-flight turn to finish, so they never abort
a generating answer.

## Troubleshooting

- `NOT_LOGGED_IN` → `node chatgpt.mjs sync` again (cookies expire).
- "too many requests" → ChatGPT is throttling; wait a few minutes and retry.
- Anything else → `node chatgpt.mjs stop`, retry, and check
  `~/.ask-chatgpt/daemon.log`.

## Security

- Drives your **real ChatGPT session** — treat it like your own.
- Cookies stay local (`~/.ask-chatgpt/`); nothing is uploaded anywhere.
- Don't paste secrets (API keys, tokens, credentials) into prompts.

## License

[MIT](LICENSE)
