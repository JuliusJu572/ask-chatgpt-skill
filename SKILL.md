---
name: ask-chatgpt
description: Ask ChatGPT (live web search + deep reasoning) from the terminal via a real logged-in Chrome session. Use it when (1) you hit a BLOCKER while developing — a stubborn bug, build/toolchain error, or confusing behavior you can't resolve on your own; (2) you need CURRENT facts beyond your knowledge — latest library/framework/API versions, release notes, CVEs, breaking changes, post-cutoff events; (3) you need ONLINE RESEARCH — gathering, cross-referencing and synthesizing large amounts of up-to-date material from the web into one coherent answer (survey a topic, compare options across sources, summarize recent developments, organize a lot of material); or (4) you want a SECOND OPINION / cross-check from another strong model while coding or writing docs. Reach for it whenever real-time web knowledge or a long-form researched answer would unblock you. Triggers include "ask chatgpt", "search the web", "look this up online", "research this", "do a web search", "latest version of", "what's new in", "release notes for", "I'm stuck", "联网搜索", "联网调研", "问chatgpt", "查一下最新的", "上网查", "查资料", "整理资料", "调研一下", "卡住了", "cross-check with another model", "get a second opinion". Supports multi-turn follow-ups that keep full conversation context across separate calls via named sessions (`-s <name>`), so you can iterate on a problem, ask "why did that fail?", or refine an answer. NOTE — one shared ChatGPT login, so never run two asks in parallel; serialize them (see Concurrency).
---

# ask-chatgpt

Ask ChatGPT through the user's **real logged-in Chrome session**; it does its own
web search + reasoning and returns clean text on stdout. Use it for **development
blockers**, **current facts beyond your knowledge**, **online research that
synthesizes a lot of web material**, or a **second model's opinion**.

It's a self-contained script (`chatgpt.mjs`) driving system Chrome with copied
login cookies — normally **no manual login**. In the commands below, `$S` is the
path to `chatgpt.mjs` inside **this skill's install directory** (e.g.
`~/.claude/skills/ask-chatgpt/chatgpt.mjs` for Claude Code or
`~/.config/opencode/skills/ask-chatgpt/chatgpt.mjs` for opencode).

## One-time setup

```bash
cd <this skill's install directory>   # e.g. ~/.claude/skills/ask-chatgpt
npm install                            # playwright dependency
node chatgpt.mjs sync                  # copy ChatGPT login cookies from your real Chrome
node chatgpt.mjs status                # -> "OK: logged in"
```

If `sync` can't log you in, the login is in another Chrome profile or expired:
`ASK_CHATGPT_CHROME_PROFILE="Profile 1" node chatgpt.mjs sync`, or `node chatgpt.mjs login` (manual, once).

## Concurrency — serialize asks (important)

One shared ChatGPT login / one background browser. **Never run two asks in
parallel** — turns interleave, a follow-up can abort a previous answer still
generating, and "too many requests" becomes likely. Wait for each answer to
finish (clean stdout, exit `0`) before starting the next, even from another
agent or terminal.

## Ask a question

```bash
S=<skill-dir>/chatgpt.mjs
node $S ask "Search the web: latest stable Node.js LTS version right now?"
```

- **stdout** = the clean answer; **stderr** = progress/diagnostics.
- Simple answers take ~15–40s. **Deep research / "Thinking" runs 7–8 minutes** —
  the default timeout is 15 min; be patient, a long pause is not a failure.
- Be specific, and ask it to **search explicitly**: `ask "Search the web: ..."`.
- Paste context (error + snippet + versions) for code questions.
- You can also pipe a prompt via stdin.

### Incomplete answers — don't mistake them for final

If the timeout is hit, the answer is **partial** and clearly marked:

- stdout begins with `[INCOMPLETE ANSWER — ...]`, and the process exits with
  code **3** (≠ `1`, which means a real error).
- **Don't treat it as final, and don't ask a follow-up yet** (that would abort
  the still-running turn). Re-run with a larger `--timeout`, or re-ask.

## Multi-turn conversations

A **named session** (`-s <name>`) maps to a ChatGPT conversation on disk, so
separate calls keep full context — use pronouns, "that", "it", and refine
iteratively:

```bash
node $S ask "Debugging this Rust borrow error: ..." -s rustbug
node $S ask "Your fix gave E0502 — why?" -s rustbug      # remembers context
node $S sessions                                          # list sessions
node $S ask "fresh start" -s rustbug --new               # rebind the name
```

Or target an id directly with `--conv <id>` (printed on every answer). A
background daemon keeps one logged-in Chrome warm; `chatgpt.mjs stop` closes it.

### Common flags

| Flag | Meaning |
|------|---------|
| `-s`, `--session <name>` | Named multi-turn session. |
| `--conv <id>` / `--new` | Continue an id / force a fresh chat. |
| `--timeout <ms>` | Timeout, default `900000` (15 min). Raise for very long research. |
| `--model <name>` | E.g. `--model "Thinking"` / `"Instant"`. |
| `--save <path>` | Also write the answer to a file. |

**Avoid `--headless`** — ChatGPT's Cloudflare protection usually blocks it.

## Troubleshooting

- **`NOT_LOGGED_IN`** → `node chatgpt.mjs sync` (or `login`).
- **`[INCOMPLETE ANSWER]` / exit 3** → partial; raise `--timeout` or re-ask.
- **"too many requests"** → ChatGPT is throttling; wait a few minutes and retry.
- **Daemon acting up** → `chatgpt.mjs stop` then retry. Logs: `~/.ask-chatgpt/daemon.log`.

## Safety

- This drives the user's **real ChatGPT session** — treat it like their own.
- **Don't paste secrets** (API keys, tokens, credentials) into prompts.
