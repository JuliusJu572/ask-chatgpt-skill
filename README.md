# ask-chatgpt

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![skills.sh](https://img.shields.io/badge/skills.sh-ask--chatgpt-blue)](https://skills.sh/juliusju572/ask-chatgpt-skill/ask-chatgpt)

Give your AI agent (Claude Code, opencode, …) the ability to **ask ChatGPT** —
with ChatGPT's own **live web search and deep reasoning** — through your **real,
logged-in Chrome session**. No API key needed; it reuses your existing ChatGPT
login. It can also **analyze images** you attach (screenshots, charts, UI, photos).

[English](#english) | [中文](#中文)

---

## English

### What it does

Lets your agent reach for ChatGPT when it is stuck on a bug, needs current
facts (latest versions, release notes, CVEs), needs to **research and
synthesize a lot of web material**, wants a **second opinion** from another
strong model, or needs to **understand an image** (a screenshot, chart, UI
mockup, photo — attach it with `--image`).

```bash
node chatgpt.mjs ask "Search the web: what's the latest stable Node.js LTS?"
node chatgpt.mjs ask "What error is shown in this screenshot and how do I fix it?" -i shot.png
```

### Install

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

### One-time setup

```bash
node chatgpt.mjs sync     # copy ChatGPT login cookies from your everyday Chrome
node chatgpt.mjs status   # -> "OK: logged in"
```

`sync` copies the ChatGPT session cookies from `~/.config/google-chrome` into
an isolated profile (`~/.ask-chatgpt/profile`). Your daily Chrome can stay
open — files are copied, the directory is not shared, and cookies never leave
your machine.

Login in a non-default Chrome profile? `ASK_CHATGPT_CHROME_PROFILE="Profile 1"
node chatgpt.mjs sync`. Or just `node chatgpt.mjs login` once, manually.

### Usage

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
  starts with `[INCOMPLETE ANSWER — …]` and the exit code is **3**
  (`0` = done, `1` = error). Don't treat a partial answer as final.
- **Requests are minimal.** Completion is detected by watching the page
  (free); each answer costs ~**one** backend request. A 429 rate-limit
  triggers a backoff, never a reload.
- **Serialize asks.** One shared login / one browser tab: run one question at
  a time, even across agents.

### Requirements

- Linux with a desktop session (headless is blocked by Cloudflare)
- Google Chrome installed and logged in to ChatGPT
- Node.js ≥ 18

### Security

- Drives your **real ChatGPT session** — treat it like your own.
- Cookies stay local (`~/.ask-chatgpt/`); nothing is uploaded anywhere.
- Don't paste secrets (API keys, tokens, credentials) into prompts.

---

## 中文

### 这是什么

让你的 AI agent（Claude Code、opencode 等）通过你**真实登录的 Chrome
浏览器**去问 ChatGPT——自带 ChatGPT 的**联网搜索和深度推理**能力。**无需 API
key**，直接复用你已有的 ChatGPT 登录态。还可以**让 ChatGPT 看图分析**（截图、
图表、UI、照片等，用 `--image` 附上）。

适用场景：agent 被 bug 卡住、需要最新信息（版本号、release notes、CVE）、
需要**联网调研并整理大量资料**、想要另一个强模型的**第二意见**，或需要**识别/
分析图片**。

```bash
node chatgpt.mjs ask "Search the web: what's the latest stable Node.js LTS?"
node chatgpt.mjs ask "这张截图里的报错是什么意思？怎么修？" -i error.png
```

### 安装

使用 [skills.sh](https://skills.sh) CLI（支持 Claude Code、opencode、Cursor、
Codex 等 20+ agent）：

```bash
npx skills add JuliusJu572/ask-chatgpt-skill
```

或手动安装：

```bash
# Claude Code
git clone https://github.com/JuliusJu572/ask-chatgpt-skill ~/.claude/skills/ask-chatgpt
cd ~/.claude/skills/ask-chatgpt && npm install

# opencode
git clone https://github.com/JuliusJu572/ask-chatgpt-skill ~/.config/opencode/skills/ask-chatgpt
cd ~/.config/opencode/skills/ask-chatgpt && npm install
```

### 一次性设置

```bash
node chatgpt.mjs sync     # 从你日常使用的 Chrome 复制 ChatGPT 登录 cookie
node chatgpt.mjs status   # -> "OK: logged in"
```

`sync` 会把 `~/.config/google-chrome` 里的 ChatGPT 会话 cookie 复制到一个
隔离的 profile（`~/.ask-chatgpt/profile`）。你日常的 Chrome 可以照常开着——
只是复制文件，不共享目录，cookie 也不会离开你的机器。

登录态在非默认 Chrome profile 里？用 `ASK_CHATGPT_CHROME_PROFILE="Profile 1"
node chatgpt.mjs sync`；或者直接手动登录一次：`node chatgpt.mjs login`。

### 使用

```bash
S=~/.claude/skills/ask-chatgpt/chatgpt.mjs   # 换成你的安装路径

# 单次提问（stdout = 干净的答案文本）
node $S ask "Search the web: current LTS version of Node.js?"

# 多轮对话：命名会话在多次调用之间保留完整上下文
node $S ask "Debugging this Rust borrow error: ..." -s rustbug
node $S ask "Your fix gave E0502 instead — why?" -s rustbug   # 记得上文

node $S sessions          # 列出命名会话
node $S stop              # 关闭后台浏览器
```

### 关键行为

- **深度研究需要几分钟。**"Thinking"/研究类回答通常要 7–8 分钟，默认超时
  15 分钟；长时间停顿不代表失败。
- **不完整答案绝不会被误认。** 超时未结束时，stdout 会以
  `[INCOMPLETE ANSWER — …]` 开头，且退出码为 **3**（`0`=完成，`1`=出错）。
  不要把部分答案当成最终答案。
- **请求量极低。** 通过观察页面（零成本）判断回答是否结束，每个回答只花
  **约 1 次**后端请求；遇到 429 限流会自动退避，绝不刷新页面。
- **请串行提问。** 同一个登录态 / 同一个浏览器标签页：一次只跑一个问题，
  多个 agent 之间也一样。

### 环境要求

- 带桌面会话的 Linux（headless 会被 Cloudflare 拦截）
- 已安装 Google Chrome 并登录了 ChatGPT
- Node.js ≥ 18

### 安全说明

- 它驱动的是你**真实的 ChatGPT 会话**——请像对待自己的会话一样对待它。
- cookie 只保存在本地（`~/.ask-chatgpt/`），不会上传到任何地方。
- 不要把密钥（API key、token、凭据）粘贴到提问内容里。

---

## License / 许可证

[MIT](LICENSE)
