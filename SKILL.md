---
name: ask-chatgpt
description: Ask ChatGPT (live web search + deep reasoning) from the terminal via a real logged-in Chrome session. Use it when (1) you hit a BLOCKER while developing — a stubborn bug, build/toolchain error, or confusing behavior you can't resolve on your own; (2) you need CURRENT facts beyond your knowledge — latest library/framework/API versions, release notes, CVEs, breaking changes, post-cutoff events; (3) you need ONLINE RESEARCH — gathering, cross-referencing and synthesizing large amounts of up-to-date material from the web into one coherent answer (survey a topic, compare options across sources, summarize recent developments, organize a lot of material); (4) you want a SECOND OPINION / cross-check from another strong model while coding or writing docs; or (5) you need to ANALYZE / UNDERSTAND AN IMAGE — a screenshot, a chart/diagram, an error dialog, a UI mockup, a photo; attach it with `--image <path>` and ChatGPT will read it (text extraction / OCR, chart reading, layout critique, "what's on screen here?"). Reach for it whenever real-time web knowledge, a long-form researched answer, or an image-recognizing second model would unblock you. Triggers include "ask chatgpt", "search the web", "look this up online", "research this", "do a web search", "latest version of", "what's new in", "release notes for", "I'm stuck", "联网搜索", "联网调研", "问chatgpt", "查一下最新的", "上网查", "查资料", "整理资料", "调研一下", "卡住了", "看这张图", "识别图片", "图片分析", "这张截图", "cross-check with another model", "get a second opinion", "analyze this image". Supports multi-turn follow-ups that keep full conversation context across separate calls via named sessions (`-s <name>`), so you can iterate on a problem, ask "why did that fail?", or refine an answer. NOTE — one shared ChatGPT login, so never run two asks in parallel; serialize them (see Concurrency).
---

# ask-chatgpt

Ask the **ChatGPT web app** through the user's own logged-in browser session. ChatGPT does
its own web search / reasoning / image reading; the clean answer comes back on stdout.

`$S` below = `chatgpt.mjs` in this skill's directory (e.g. `~/.claude/skills/ask-chatgpt/chatgpt.mjs`).

## How it works (v2)

A dedicated Chromium/Chrome runs in the background (profile `~/.ask-chatgpt/profile`) and
stays logged in. Each call attaches to it, types the prompt, presses Enter and **confirms the
send by seeing ChatGPT's network request**. Completion is ChatGPT's own WebSocket
`conversation-turn-complete` event; the answer is then read once from
`/backend-api/conversation/<id>`. No CSS-class scraping, so UI language/layout changes
don't break it. Usually exactly **1 API read per answer**.

## Ask

```bash
node $S ask "Search the web: latest stable Node.js LTS version?"
node $S ask "这张截图里的报错是什么意思？" -i error.png        # image / file (repeatable -i)
printf '%s' "$LONG_PROMPT" | node $S ask                        # prompt via stdin (multi-line OK)
```

- **stdout** = answer only. **stderr** = progress (`sent ...`, `done in Ns via api | conversation_id ...`).
- Exit **0** = complete. **1** = error (message on stderr). **3** = INCOMPLETE (see below).
- Simple answers: 15–40 s. Heavy models (e.g. "... Max", deep research, agent mode that
  runs tools) can take **10+ minutes** — a long silence is not a failure; stderr prints
  `ChatGPT is working ... Ns` every 30 s.
- Be specific; say "Search the web:" when you need fresh facts; paste errors + versions.

### Long questions vs. the 10-minute Bash limit

The default `--timeout` is 15 min, longer than a foreground Bash call may last. For anything
that may run long, either run the ask with `run_in_background: true`, or cap it and collect later:

```bash
node $S ask "<deep research prompt>" -s topic --timeout 540000   # exit 3 if not done in 9 min
node $S fetch -s topic --wait --timeout 540000                   # collect the finished answer
```

`fetch` sends nothing — it only reads the conversation, so it is also the recovery path after
an interrupted/killed ask (ChatGPT keeps generating server-side).

### Incomplete answers (exit 3)

stdout starts with `[INCOMPLETE ANSWER — ...]`. Don't treat it as final and **don't send a
follow-up yet** (it would interrupt the running turn). Run `fetch ... --wait` instead.

## Multi-turn

```bash
node $S ask "Debugging this Rust borrow error: ..." -s rustbug   # creates / continues "rustbug"
node $S ask "Your fix gave E0502 — why?" -s rustbug               # same conversation, full context
node $S ask "fresh start" -s rustbug --new                        # rebind the name to a new chat
node $S sessions            # list    |   node $S sessions --forget rustbug
```

Also: `--conv <id>` continues a specific conversation; `--no-new` continues the last one.
Without `-s/--conv/--no-new` every ask is a **new chat**.

## Concurrency

One ChatGPT login → asks are **serialized automatically** with a lock: a second caller
prints `waiting for another ask to finish ...` and runs afterwards. Still, prefer running
asks one after another — a long research run blocks everyone behind it.

## Other commands / flags

| | |
|---|---|
| `status` / `start` / `stop` | login state + browser / start it / close it |
| `models` | list the models in ChatGPT's picker; then `ask ... -m "<name>"` |
| `list [--limit n] [--agent-only]` | recent conversations |
| `--save <path>` | also write the answer to a file |
| `--title <t>` / `--no-rename` | title of a new chat (default `[AGENT] <prompt>`) |
| `--headless` | avoid — Cloudflare usually blocks it |

## Troubleshooting

- `NOT_LOGGED_IN` → `node $S login` (log in once in the window), or `node $S sync` to copy
  cookies from the user's Chrome (only works with the same browser family).
- `too many requests (429)` → ChatGPT throttling; wait a few minutes.
- Anything odd → `node $S stop` and retry (the next ask starts a fresh browser).
  Screenshots of failures: `~/.ask-chatgpt/debug/`. Browser log: `~/.ask-chatgpt/browser.log`.

## Safety

This is the user's real ChatGPT account — treat it as theirs. Never paste secrets
(API keys, tokens, credentials) into prompts.
