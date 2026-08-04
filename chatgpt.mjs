#!/usr/bin/env node
/**
 * ask-chatgpt — Ask ChatGPT (with web search / thinking) from the terminal.
 *
 * Self-contained Playwright automation. Logs into chatgpt.com once (persisted
 * browser profile), then sends prompts and captures the final answer.
 *
 * Subcommands:
 *   login                 Open a browser to log into ChatGPT (one-time).
 *   status                Check whether the persisted profile is logged in.
 *   ask "<prompt>"        Send a prompt and print ChatGPT's answer to stdout.
 *
 * Flags (ask):
 *   --timeout <ms>        Response timeout (default 300000 = 5 min).
 *   --model <name>        Switch model in the UI (e.g. "Instant", "Thinking").
 *   --headless            Run without a visible window (NOT recommended:
 *                         ChatGPT's Cloudflare protection usually blocks it).
 *   --no-new              Reuse the current conversation instead of a new chat.
 *   --html                Also print the raw answer HTML to stderr.
 *   --save <path>         Write the answer text to a file.
 *
 * Diagnostics go to stderr; the final answer goes to stdout (clean for piping).
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROFILE_DIR =
  process.env.ASK_CHATGPT_PROFILE || path.join(os.homedir(), '.ask-chatgpt', 'profile');

const STATE_DIR = path.join(os.homedir(), '.ask-chatgpt');
const DAEMON_STATE = path.join(STATE_DIR, 'daemon.json');
const DAEMON_LOG = path.join(STATE_DIR, 'daemon.log');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');

const CHATGPT_URL = 'https://chatgpt.com/';
const LOGIN_URL = 'https://chatgpt.com/auth/login';
// Deep research / "Thinking" answers routinely run 7-8 minutes, so a 5-minute
// default would time out on healthy runs and hand back a partial answer.
const DEFAULT_TIMEOUT = 15 * 60 * 1000;

// Exit code used when the answer came back INCOMPLETE. Distinct from 1 (real
// error) so a caller can tell "ChatGPT wasn't done" from "the tool broke".
const EXIT_INCOMPLETE = 3;

// Anti-hang tunables. ChatGPT's client stream sometimes dies while the server
// keeps generating (or finishes); we detect "no forward progress" and reload the
// page, which re-establishes the stream and re-renders server state.
// Env-overridable so slow links can be accommodated (and so the recovery path
// can be exercised deliberately).
const envInt = (name, dflt) => {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
// ---------------------------------------------------------------------------
// Pacing. The key asymmetry:
//
//   * Watching the DOM is FREE — Playwright talks to the browser over CDP, in
//     process, zero HTTP. The page is already receiving the answer over
//     ChatGPT's own SSE stream, so the browser knows the turn finished before
//     any API call could tell us.
//   * Every /backend-api call is a REAL request that counts against the rate
//     limiter ("too many requests").
//
// So the DOM decides WHEN the answer is done, and the API is used once at the
// end to fetch clean markdown. A 15-minute research run costs ~1 API call
// instead of the ~45 a 20s poll would spend — and it reacts faster, because a
// DOM mutation is instant.
//
// The API is only consulted extra when the DOM goes quiet for a long time, to
// tell "server still working" apart from "stream died". Those checks are spaced
// at least API_MIN_GAP_MS apart, so they can never become a hot loop.
// ---------------------------------------------------------------------------
const DOM_POLL_MS = envInt('ASK_CHATGPT_DOM_POLL_MS', 1000); // free, in-process
const DOM_QUIET_MS = envInt('ASK_CHATGPT_DOM_QUIET_MS', 2500); // DOM still this long -> settled
const API_MIN_GAP_MS = envInt('ASK_CHATGPT_API_GAP_MS', 60000); // floor between API calls
const IDLE_CHECK_MS = envInt('ASK_CHATGPT_IDLE_CHECK_MS', 120000); // DOM silent -> ask server once
const SILENT_RELOAD_MS = envInt('ASK_CHATGPT_SILENT_RELOAD_MS', 420000); // truly dead -> reload
const MAX_STALL_RELOADS = envInt('ASK_CHATGPT_MAX_RELOADS', 2); // then take what we have
const MAX_API_REFUSALS = envInt('ASK_CHATGPT_MAX_API_REFUSALS', 8); // 404/403 streak -> use DOM
const PAGE_OP_TIMEOUT = envInt('ASK_CHATGPT_PAGE_OP_MS', 45000); // cap on any single page call
// How long to wait (watching the DOM, free) for the answer to START streaming
// before asking the server whether the turn is in flight at all. Until streaming
// has been seen, a quiet DOM means "not started yet", NOT "finished" — without
// this the very first API call would be spent on an empty page and the real
// completion check would then be stuck behind API_MIN_GAP_MS.
const STREAM_START_MS = envInt('ASK_CHATGPT_STREAM_START_MS', 15000);
// ChatGPT's stop button sometimes stays on screen after the answer is finished.
// Streaming text always mutates the DOM, so a visible stop button plus a DOM that
// has not moved for this long means the stream is over regardless of what the
// button says. Without this, a stuck button defers the answer to the slow idle
// check — observed as a one-word reply taking 133s instead of 9s.
const STREAM_STALL_MS = envInt('ASK_CHATGPT_STREAM_STALL_MS', 8000);
// Same idea, but once the server has confirmed it is working: research legitimately
// pauses between steps, so require a longer stall before doubting the button.
const RESEARCH_STALL_MS = envInt('ASK_CHATGPT_RESEARCH_STALL_MS', 60000);
// Gap floor before the turn is known to be in flight. Small, because these are
// one-off checks at the start of a turn, not a polling loop.
const FIRST_CONFIRM_GAP_MS = envInt('ASK_CHATGPT_FIRST_GAP_MS', 8000);
// Retained name: used for coarse waits that are NOT server polls.
const POLL_MS = DOM_POLL_MS;

const SELECTORS = {
  composer:
    '#prompt-textarea.ProseMirror[contenteditable="true"][role="textbox"], #prompt-textarea[contenteditable="true"], [data-testid="composer-input"], div.ProseMirror[contenteditable="true"], textarea',
  sendButton:
    '#composer-submit-button, button[aria-label="Send prompt"], [data-testid="send-button"]',
  stopButton:
    'button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[aria-label="Stop response"], button[aria-label^="Stop" i], button[aria-label*="停止" i]',
  loginPage: 'button:has-text("Log in"), button:has-text("Sign up")',
  newChat:
    'a[href="/"][aria-label="New chat"], a:has-text("New chat"), [data-testid="create-new-chat-button"]',
  modelPicker: 'button[data-testid="model-switcher-dropdown-button"]',
  modelOption: '[role="menuitem"]',
};

// Selectors used to count assistant turns (to detect a NEW response arriving).
const TURN_COUNT_SELECTORS = [
  'div.agent-turn',
  'article[data-testid^="conversation-turn-"]:has(.markdown)',
  'div[data-message-id]:has(.markdown)',
  '[data-message-author-role="assistant"]',
];

// Selectors used to extract the latest assistant answer content (in priority order).
const ANSWER_SELECTORS = [
  'div.agent-turn .markdown',
  'article[data-testid^="conversation-turn-"]:has(.markdown) .markdown',
  'div[data-message-id]:has(.markdown) .markdown',
  'div.agent-turn',
  'article[data-testid^="conversation-turn-"]:has(.markdown)',
  'div[data-message-id]:has(.markdown)',
  '[data-message-author-role="assistant"]',
  '.markdown',
];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

// Timestamped, because the daemon log is the only record of what happened during a
// long unattended run — and without a clock there is no way to tell a deliberate
// `stop` apart from a crash, or to line an event up with the ask that caused it.
const log = (...args) => {
  const t = new Date().toISOString().slice(11, 19);
  console.error(`[ask-chatgpt ${t}]`, ...args);
};

/**
 * Hard deadline for a single page operation.
 *
 * Playwright calls normally have their own timeouts, but a wedged renderer (or a
 * page whose main thread is blocked) can leave an `evaluate` pending forever.
 * Every page call in the response path goes through this so a stuck browser can
 * never wedge the daemon: the caller gets a rejection and can reload/recover.
 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`page op timed out after ${ms}ms: ${label}`);
        err.code = 'PAGE_OP_TIMEOUT';
        reject(err);
      }, ms);
    }),
  ]);
}

/** Same, but never throws — returns `fallback` if the op times out or fails. */
async function softly(promise, ms, label, fallback = null) {
  try {
    return await withTimeout(promise, ms, label);
  } catch {
    return fallback;
  }
}

// ChatGPT wraps inline citation widgets in Unicode private-use delimiters
// (U+E200 start, U+E202 separator, U+E201 end). They render as source chips in
// the UI but are pure noise as text, e.g.
//   "...published June 23, 2026. <U+E200>cite<U+E202>turn450093search0<U+E201>"
// Built from char codes so the source stays ASCII-only and cannot be mangled by
// an editor silently eating invisible characters.
const PUA_CITE_OPEN = String.fromCharCode(0xe200);
const PUA_CITE_CLOSE = String.fromCharCode(0xe201);
const RE_CITE_BLOCK = new RegExp(PUA_CITE_OPEN + '[\\s\\S]*?' + PUA_CITE_CLOSE, 'g');
const RE_PUA_STRAY = new RegExp(
  '[' + String.fromCharCode(0xe200) + '-' + String.fromCharCode(0xe20f) + ']',
  'g',
);

/** Strip citation widgets so the answer text is clean for terminals and pipes. */
function cleanAnswer(text) {
  return (text || '')
    .replace(RE_CITE_BLOCK, '')
    .replace(/\bcite(?:turn\w*)+/g, '') // leftover from an unclosed block
    .replace(RE_PUA_STRAY, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseArgs(argv) {
  const opts = {
    _: [],
    timeout: DEFAULT_TIMEOUT,
    headless: false,
    chromium: false,
    model: null,
    newChat: false,
    html: false,
    save: null,
    conv: null,
    title: null,
    noRename: false,
    limit: 20,
    json: false,
    agentOnly: false,
    session: null,
    dom: false,
    images: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--timeout':
        opts.timeout = parseInt(argv[++i], 10) || DEFAULT_TIMEOUT;
        break;
      case '--headless':
        opts.headless = true;
        break;
      case '--chromium':
        opts.chromium = true;
        break;
      case '--model':
        opts.model = argv[++i];
        break;
      case '--new':
        opts.newChat = true;
        break;
      case '--no-new':
        opts.newChat = false;
        break;
      case '--html':
        opts.html = true;
        break;
      case '--save':
        opts.save = argv[++i];
        break;
      case '--conv':
      case '--continue':
        opts.conv = argv[++i];
        break;
      case '--title':
        opts.title = argv[++i];
        break;
      case '--no-rename':
        opts.noRename = true;
        break;
      case '--limit':
        opts.limit = parseInt(argv[++i], 10) || 20;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--agent-only':
        opts.agentOnly = true;
        break;
      case '--session':
      case '-s':
        opts.session = argv[++i];
        break;
      case '--dom':
        opts.dom = true;
        break;
      case '--image':
      case '-i':
        opts.images.push(argv[++i]);
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        opts._.push(a);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`ask-chatgpt — ask ChatGPT (web search + reasoning) via a persistent Chrome session

A background daemon keeps ONE logged-in Chrome open so you can ask many
follow-up questions without relaunching. The browser stays open until you "stop".

Setup (once):
  chatgpt.mjs sync                  Copy ChatGPT login cookies from your real Chrome
  chatgpt.mjs status                Check daemon + login status

Ask / multi-turn:
  chatgpt.mjs ask "<prompt>"        One question (auto-starts daemon). Prints the answer;
                                    conversation_id is printed to stderr for follow-ups.
  chatgpt.mjs ask "<more>" -s work  NAMED SESSION: remembers the conversation across
                                    separate CLI calls. Best way to do multi-turn.
  chatgpt.mjs ask "<more>" --conv <id>   Continue a specific conversation id.
  chatgpt.mjs ask "<new>" --new          Force a brand-new conversation.
  chatgpt.mjs chat [-s <name>]      Interactive: read prompts from stdin line by line,
                                    browser stays open between them (end: empty line/exit/Ctrl+D).
  chatgpt.mjs list [--agent-only]   List conversations (id<TAB>title); --agent-only shows [AGENT] ones.
  chatgpt.mjs sessions              Show named sessions.  sessions --forget <name>  drops one.

Daemon control:
  chatgpt.mjs start                 Start the daemon (open the browser) explicitly.
  chatgpt.mjs stop                  Stop the daemon and CLOSE the browser.
  chatgpt.mjs status                Daemon health + login state.

Auth:
  chatgpt.mjs sync                  Reuse your Chrome login (preferred).
  chatgpt.mjs login                 Manual login in a browser window (fallback).

Common flags:
  -s, --session <name>  Named multi-turn session, remembered across CLI calls.
  --conv <id>        Continue this conversation id.
  --new              Force a new conversation (default: continue the current one).
  --dom              Force DOM scraping instead of the server API (debug/fallback).
  --title <text>     Set the conversation title (auto-prefixed with "[AGENT] ").
  --no-rename        Don't auto-rename the conversation to "[AGENT] ...".
  --timeout <ms>     Response timeout (default 300000).
  --model <name>     Switch model in the UI (e.g. "Thinking", "Instant").
  --save <path>      Also write the answer text to a file.
  -i, --image <p>     Attach an image (path). Repeatable for several images.
                      ChatGPT sees them and answers about them.
  --html             Print raw answer HTML to stderr.
  --json             (list) JSON output.   --limit <n>  (list) how many (default 20).
  --headless         Run headless (usually blocked by Cloudflare — avoid).
  --chromium         Force bundled Chromium instead of system Google Chrome.

Environment:
  ASK_CHATGPT_PROFILE          Skill browser profile dir (default ~/.ask-chatgpt/profile)
  ASK_CHATGPT_SOURCE_PROFILE   Real Chrome profile root for "sync" (default ~/.config/google-chrome)
  ASK_CHATGPT_CHROME_PROFILE   Chrome profile name for "sync" (default "Default")
  ASK_CHATGPT_CHANNEL          Browser channel: "chrome" or "chromium"
`);
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

/**
 * Decide which browser binary to drive.
 *
 * We PREFER the system Google Chrome (`channel: 'chrome'`) because ChatGPT's
 * login cookies are encrypted with a key that only the real Chrome binary can
 * read from the OS keyring. Playwright's bundled Chromium uses a different
 * keyring entry and therefore cannot decrypt cookies copied from Chrome.
 * Set ASK_CHATGPT_CHANNEL=chromium (or pass --chromium) to force the bundled one.
 */
function detectChannel(forceChromium) {
  if (forceChromium) return undefined;
  if (process.env.ASK_CHATGPT_CHANNEL) {
    return process.env.ASK_CHATGPT_CHANNEL === 'chromium' ? undefined : process.env.ASK_CHATGPT_CHANNEL;
  }
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  if (candidates.some((p) => fs.existsSync(p))) return 'chrome';
  return undefined; // fall back to bundled chromium
}

/**
 * Remove Chrome's single-instance locks if the process that held them is gone.
 *
 * Chrome deletes these on a clean exit, but a SIGKILL / OOM kill / crash leaves
 * them behind. A new Chrome then sees "another instance is already running",
 * hands the command line to that (nonexistent) instance, prints "opening in an
 * existing browser session" and exits 0 — so Playwright reports the context as
 * closed and a relaunch can never succeed. Clearing them is what makes crash
 * recovery possible at all.
 *
 * SingletonLock is a symlink whose target ends in -<pid>, so we can check whether
 * the owner is genuinely dead instead of stomping on a live browser.
 */
function clearStaleProfileLocks() {
  const lock = path.join(PROFILE_DIR, 'SingletonLock');
  let target = null;
  try {
    target = fs.readlinkSync(lock);
  } catch {
    return; // no lock, or not a symlink — nothing to do
  }
  const m = /-(\d+)$/.exec(target || '');
  const pid = m ? parseInt(m[1], 10) : NaN;
  if (Number.isFinite(pid) && isPidAlive(pid)) {
    log(`profile is locked by a live Chrome (pid ${pid}) — leaving it alone`);
    return;
  }
  log('clearing stale Chrome profile locks left by a crashed browser');
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(PROFILE_DIR, name), { force: true });
    } catch {
      /* best effort */
    }
  }
}

async function launch(headless, forceChromium = false) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  clearStaleProfileLocks();
  const channel = detectChannel(forceChromium);
  const opts = {
    headless,
    viewport: { width: 1280, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      // CRITICAL: Playwright defaults to --password-store=basic, which makes
      // Chrome decrypt cookies with a hardcoded dummy key. Cookies copied
      // from the user's real Chrome are encrypted with the GNOME-keyring key
      // (v11), so we MUST use the real keyring or the login cookies won't
      // decrypt and the session is lost.
      '--password-store=gnome',
    ],
  };
  if (channel) opts.channel = channel;
  log('using browser:', channel || 'bundled chromium');
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, opts);
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

function copyFileIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.copyFileSync(src, dest);
  return true;
}

/**
 * Copy login cookies from the user's real Chrome profile into our isolated
 * skill profile. Lets `ask` reuse the existing ChatGPT login with no re-login.
 * Safe to run while Chrome is open (we copy files, we don't share the dir).
 */
async function cmdSync(opts) {
  await stopDaemon(); // free the profile lock held by the daemon (if any)
  const src =
    process.env.ASK_CHATGPT_SOURCE_PROFILE || path.join(os.homedir(), '.config', 'google-chrome');
  const prof = process.env.ASK_CHATGPT_CHROME_PROFILE || 'Default';
  const srcDefault = path.join(src, prof);

  if (!fs.existsSync(path.join(srcDefault, 'Cookies'))) {
    throw new Error(
      `Chrome cookies not found at ${srcDefault}\n` +
        'Set ASK_CHATGPT_SOURCE_PROFILE (profile root) and/or ASK_CHATGPT_CHROME_PROFILE (e.g. "Profile 1").',
    );
  }

  fs.mkdirSync(path.join(PROFILE_DIR, 'Default'), { recursive: true });

  // What we copy and why:
  //   Default/Cookies (+journal) — the session cookies (ChatGPT auth is
  //     cookie-based; the session token is stored chunked as
  //     __Secure-next-auth.session-token.0/.1).
  //   Local State — holds the os_crypt key reference needed to decrypt the
  //     v11-encrypted cookie values.
  // We deliberately do NOT copy `Local Storage` (a leveldb dir): copied while
  // Chrome is running it can be inconsistent and has crashed Chrome 143 on
  // startup. It isn't needed for the login session.
  // Decryption also requires launching with --password-store=gnome (see launch()).
  let copied = 0;
  for (const f of ['Cookies', 'Cookies-journal']) {
    if (copyFileIfExists(path.join(srcDefault, f), path.join(PROFILE_DIR, 'Default', f))) copied++;
  }
  copyFileIfExists(path.join(src, 'Local State'), path.join(PROFILE_DIR, 'Local State'));
  if (copied === 0) {
    throw new Error('No Cookies file found in ' + srcDefault);
  }

  log('copied cookies:', srcDefault, '->', PROFILE_DIR);
  console.log('OK: cookies synced from ' + srcDefault);
  log('now test with: node chatgpt.mjs status');
}

async function isCloudflareChallenge(page) {
  const title = await page.title().catch(() => '');
  if (title === 'Just a moment...' || title.toLowerCase().includes('checking your browser')) {
    return true;
  }
  return page
    .locator('#challenge-running, #challenge-form, .cf-browser-verification')
    .first()
    .isVisible()
    .catch(() => false);
}

/** Dismiss onboarding modals / cookie banners that can block the composer. */
async function dismissOverlays(page) {
  const overlaySelectors = [
    '#modal-no-auth-login button:has-text("Stay logged out")',
    '#modal-no-auth-login button:has-text("Continue without login")',
    '#modal-no-auth-login button:has-text("Not now")',
    '#modal-no-auth-login button[aria-label="Close"]',
    '#modal-onboarding button:has-text("Skip")',
    '#modal-onboarding button:has-text("Next")',
    '#modal-onboarding button:has-text("Okay")',
    '#modal-onboarding button:has-text("Got it")',
    '#modal-onboarding button:has-text("Done")',
    '[data-testid="onboarding-skip"]',
    'dialog button:has-text("Dismiss")',
    'dialog button:has-text("Close")',
    '[role="dialog"] button[aria-label="Close"]',
    'button:has-text("Decline optional cookies")',
    'button:has-text("Accept all")',
    'button:has-text("Stay logged out")',
  ];
  for (const sel of overlaySelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ force: true });
        await page.waitForTimeout(250);
      }
    } catch {
      /* overlay may not exist */
    }
  }
  const noAuth = page.locator('#modal-no-auth-login').first();
  if (await noAuth.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
  }
}

async function composerVisible(page) {
  return page.evaluate((sel) => {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      if (el instanceof HTMLElement && el.offsetWidth > 0 && el.offsetHeight > 0) return true;
    }
    return false;
  }, SELECTORS.composer);
}

async function isLoggedIn(page) {
  if (await isCloudflareChallenge(page)) {
    const err = new Error(
      'Cloudflare bot-protection is blocking the browser. ChatGPT needs a visible window — drop --headless.',
    );
    err.code = 'CLOUDFLARE';
    throw err;
  }
  await page
    .locator(`${SELECTORS.composer}, ${SELECTORS.loginPage}`)
    .first()
    .waitFor({ state: 'visible', timeout: 8000 })
    .catch(() => {});
  if (await isCloudflareChallenge(page)) {
    const err = new Error('Cloudflare bot-protection is blocking the browser.');
    err.code = 'CLOUDFLARE';
    throw err;
  }
  await dismissOverlays(page);
  if (await composerVisible(page)) return true;
  return false;
}

/**
 * Definitive login check: does the browser hold a ChatGPT session-token cookie?
 * Anonymous mode also shows a composer, so UI heuristics give false positives;
 * the presence of __Secure-next-auth.session-token (stored chunked as .0/.1)
 * is the ground truth. Requires the cookies to have decrypted (see launch()).
 */
async function isAuthed(ctx) {
  try {
    const cookies = await ctx.cookies('https://chatgpt.com');
    return cookies.some((c) => /session-token/i.test(c.name));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Submission + capture
// ---------------------------------------------------------------------------

async function selectModel(page, model) {
  await dismissOverlays(page);
  const picker = page.locator(SELECTORS.modelPicker).first();
  if (!(await picker.isVisible().catch(() => false))) {
    log(`model picker not found — skipping model selection ("${model}")`);
    return;
  }
  const current = (await picker.textContent().catch(() => '')) || '';
  if (current.toLowerCase().includes(model.toLowerCase())) return;
  await picker.click();
  await page.waitForTimeout(700);
  const clicked = await page.evaluate(
    ({ label, optionSel }) => {
      const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const opt = Array.from(document.querySelectorAll(optionSel)).find(
        (el) => isVisible(el) && norm(el.textContent).includes(label),
      );
      if (opt instanceof HTMLElement) {
        opt.click();
        return true;
      }
      return false;
    },
    { label: model.toLowerCase(), optionSel: SELECTORS.modelOption },
  );
  if (!clicked) {
    log(`model "${model}" not found — using current model`);
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(400);
}

async function startNewChat(page) {
  try {
    const btn = page.locator(SELECTORS.newChat).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(800);
      return;
    }
  } catch {
    /* fall through */
  }
  // Fallback: navigating to the root URL opens a fresh composer.
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
}

/**
 * Attach one or more image files to the composer.
 *
 * ChatGPT's image upload accepts files through a hidden <input type="file">.
 * Playwright's setInputFiles is the most reliable way to drive it — it bypasses
 * the OS file dialog entirely — so we find the input and set the resolved paths.
 * We try, in order: the composer's own file input; any generic hidden file
 * input that accepts images; plus the "paperclip" attach button as a trigger.
 */
async function uploadImages(page, images) {
  const paths = [];
  for (const img of images) {
    const p = path.resolve(img);
    if (!fs.existsSync(p)) throw new Error('image not found: ' + img);
    paths.push(p);
  }
  // Candidate file inputs. ChatGPT renders several over its lifecycle; try the
  // most specific first, then a broad fallback. visibility:hidden (not display:none)
  // is how ChatGPT keeps these usable-by-script but invisible.
  const inputSelectors = [
    'composer input[type="file"]',
    'div[class*="composer"] input[type="file"]',
    '#composition-helli-input', // legacy attach input id
    'input[type="file"][accept*="image"]',
    'input[type="file"]',
  ];
  async function trySetInput() {
    for (const sel of inputSelectors) {
      const loc = page.locator(sel).last();
      const count = await loc.count().catch(() => 0);
      if (!count) continue;
      try {
        await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      } catch { /* ignore */ }
      const ok = await loc
        .evaluate((el) => el instanceof HTMLInputElement && el.type === 'file', undefined)
        .catch(() => false);
      if (!ok) continue;
      try {
        await loc.setInputFiles(paths);
        return true;
      } catch (e) {
        log('image upload via %s failed: %s', sel, e.message);
      }
    }
    return false;
  }

  let attached = await trySetInput();
  if (!attached) {
    // Trigger the attach (paperclip) button to reveal a file input.
    for (const sel of ['button[data-testid*="attach"], button[aria-label*="attach" i], button[aria-label*="upload" i], button[aria-label*="attachment" i]']) {
      const btn = page.locator(sel).first();
      if (!(await btn.isVisible().catch(() => false))) continue;
      await btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(600);
      attached = await trySetInput();
      if (attached) break;
    }
  }
  if (!attached) throw new Error('could not find a ChatGPT file-upload input to set images');

  // Wait for the upload thumbnails / "image attached" state to render so ChatGPT
  // actually sends them with the prompt. A generous wait: large images upload slowly.
  await page.waitForTimeout(800);
  try {
    await page
      .locator('img[alt*="uploaded image" i], div[data-testid*="upload"], img[src^="data:image"], img[src^="blob:"], img[alt*="上传" i]')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });
  } catch { /* best-effort; ChatGPT accepts the files even if the thumb is not found */ }
}

async function submitPrompt(page, prompt, images) {
  await dismissOverlays(page);

  // Find the first VISIBLE composer (ChatGPT has a hidden fallback textarea).
  let composer = page.locator(SELECTORS.composer).first();
  for (const sel of SELECTORS.composer.split(',').map((s) => s.trim())) {
    const cand = page.locator(sel).first();
    if (await cand.isVisible().catch(() => false)) {
      composer = cand;
      break;
    }
  }
  await composer.waitFor({ state: 'visible', timeout: 20000 });
  await composer.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');

  const isEditable = await composer
    .evaluate((el) => el instanceof HTMLElement && (el.isContentEditable || el.getAttribute('contenteditable') === 'true'))
    .catch(() => false);

  if (isEditable) {
    try {
      await page.keyboard.insertText(prompt);
    } catch {
      await composer.evaluate((el, text) => {
        if (!(el instanceof HTMLElement)) return;
        el.focus();
        el.innerText = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, prompt);
    }
  } else {
    try {
      await composer.fill(prompt);
    } catch {
      await composer.evaluate((el, text) => {
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) el.value = text;
        else if (el instanceof HTMLElement) el.innerText = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, prompt);
    }
  }

  // Image upload happens AFTER the text so the prompt is the turn's text and the
  // images are attachments. ChatGPT attaches to the draft currently in focus.
  if (Array.isArray(images) && images.length) {
    log('uploading %d image(s) ...', images.length);
    await uploadImages(page, images);
    await page.waitForTimeout(400);
  }

  await page.waitForTimeout(300);
  const send = page.locator(SELECTORS.sendButton).first();
  await send.waitFor({ state: 'visible', timeout: 5000 });
  await send.click();
}

async function getTurnCount(page) {
  for (const sel of TURN_COUNT_SELECTORS) {
    const n = await page.locator(sel).count().catch(() => 0);
    if (n > 0) return n;
  }
  return 0;
}

/**
 * Snapshot the DOM state BEFORE submitting a prompt. captureResponseDom
 * compares against this to detect the new answer. Capturing it pre-submit is
 * essential for continuing an existing conversation (where the URL does not
 * change): if we measured the turn count after submitting, the new turns would
 * already be counted and we'd never see an "increase".
 */
async function getBaseline(page) {
  const turns = await getTurnCount(page);
  const snap = await getLatestAnswer(page);
  return { turns, text: snap.text, url: page.url() };
}

/**
 * Reload the page to re-sync the DOM from the server. ChatGPT sometimes has the
 * finished answer on the server while the live DOM stops updating; a reload
 * re-renders the conversation and the completed answer appears. Used as a
 * recovery step when capture stalls.
 */
async function reloadPage(page) {
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await dismissOverlays(page);
  } catch (e) {
    log('reload failed:', e.message);
  }
}

/** Extract { text, html } of the latest visible assistant answer. */
async function getLatestAnswer(page) {
  return page.evaluate((selectors) => {
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.hidden) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const sel of selectors) {
      const matches = Array.from(document.querySelectorAll(sel));
      if (!matches.length) continue;
      const visible = matches.filter(isVisible);
      const last = (visible.length ? visible : matches).at(-1);
      if (!(last instanceof Element)) continue;
      const text = (last instanceof HTMLElement ? last.innerText || last.textContent : last.textContent || '').trim();
      const html = 'innerHTML' in last ? last.innerHTML || '' : '';
      return { found: true, text, html };
    }
    return { found: false, text: '', html: '' };
  }, ANSWER_SELECTORS);
}

// Short status phrases ChatGPT shows while reasoning / searching the web.
// These appear before (and instead of) the real answer, so we must not treat
// them as a finished response.
const IN_PROGRESS_RE =
  /^(thinking|searching|analyzing|analysing|reading|working|browsing|reasoning|looking|finding|running|planning|citing|正在思考|正在搜索|正在分析|正在阅读|正在浏览|正在推理|正在查找|正在运行|正在规划|正在引用|正在联网|联网搜索|搜索中|思考中)[\s.。…!！]*$/i;

function isPlaceholderText(text) {
  const t = (text || '').trim();
  if (!t) return true;
  return IN_PROGRESS_RE.test(t);
}

async function isStreaming(page) {
  // A visible stop button means generation is still running.
  return page
    .locator(SELECTORS.stopButton)
    .first()
    .isVisible()
    .catch(() => false);
}

/**
 * Resolve the conversation id for the turn we just submitted.
 * A brand-new chat navigates / -> /c/<id> a couple of seconds after submit.
 */
async function resolveConversationId(page, existing, timeoutMs = 30000) {
  if (existing) return existing;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const id = getConversationIdFromUrl(page.url());
    if (id) return id;
    if (page.isClosed()) return null;
    await sleep(300);
  }
  return null;
}

/**
 * Wait until the target conversation has no turn in flight.
 *
 * Submitting while ChatGPT is still generating ABORTS the previous answer. That
 * happens when a caller fires the next question too early — e.g. after a previous
 * call returned a partial answer while the server kept working, or when a second
 * agent picks up the same session. Rather than clobbering it, we let the in-flight
 * turn land first.
 *
 * Costs ONE request in the common case: a single authoritative check says "idle"
 * and we submit. Only if that check says "generating" do we wait, and that wait
 * is free — the DOM tells us when streaming stops, with sparse API confirmations
 * at most one per API_MIN_GAP_MS.
 */
async function waitUntilIdle(page, convId, maxWaitMs, note) {
  if (!convId) return true;
  const start = Date.now();

  // Free pre-check. Opening a conversation reconnects to its in-flight stream, so
  // if no stop button is showing and the page is still, there is nothing running —
  // which is the normal case, and now costs zero requests.
  const dom = await softly(readDomState(page), 15000, 'idle dom', null);
  if (dom && !dom.streaming && dom.quietMs >= DOM_QUIET_MS) return true;

  const serverBusy = async () => {
    const snap = await softly(
      callApi(page, { op: 'poll', convId, baselineIds: [], baselineMax: 0 }),
      20000,
      'idle poll',
      null,
    );
    if (!snap || !snap.ok) return false; // can't tell — don't block the ask
    return !!snap.generating;
  };

  if (!(await serverBusy())) return true;

  if (note) {
    note(
      'previous turn in this conversation is still generating — waiting for it ' +
        'to finish so this question does not abort it',
    );
  }

  let lastCheck = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(DOM_POLL_MS);
    const dom = await softly(readDomState(page), 15000, 'idle dom', null);
    const looksDone = dom && !dom.streaming && dom.quietMs >= DOM_QUIET_MS;
    // Confirm on the server only when the page suggests it finished, or when the
    // gap has elapsed anyway (covers a turn generating in someone else's tab,
    // which this page never streams).
    if ((looksDone || Date.now() - lastCheck >= IDLE_CHECK_MS) && Date.now() - lastCheck >= API_MIN_GAP_MS) {
      lastCheck = Date.now();
      if (!(await serverBusy())) return true;
    }
  }
  if (note) note('previous turn still running after ' + Math.round(maxWaitMs / 1000) + 's — submitting anyway');
  return false;
}

/**
 * Read the page's own view of the turn: is it still streaming, and when did the
 * conversation DOM last change?
 *
 * A MutationObserver is installed once per page and records a timestamp on every
 * mutation. That turns "has anything happened?" into reading two numbers, and it
 * costs nothing on the network — the page is already being fed by ChatGPT's SSE
 * stream. Self-installing, because a reload wipes the observer.
 */
async function readDomState(page) {
  return withTimeout(
    page.evaluate(
      ({ stopSel, turnSels }) => {
        const w = window;
        if (!w.__askObs) {
          const state = { lastChange: Date.now(), mutations: 0 };
          const target =
            document.querySelector('main') || document.body || document.documentElement;
          try {
            const obs = new MutationObserver((records) => {
              state.mutations += records.length;
              state.lastChange = Date.now();
            });
            obs.observe(target, {
              childList: true,
              subtree: true,
              characterData: true,
            });
            w.__askObs = { state, obs };
          } catch {
            w.__askObs = { state, obs: null };
          }
        }
        const st = w.__askObs.state;

        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const streaming = Array.from(document.querySelectorAll(stopSel)).some(visible);
        let turns = 0;
        for (const sel of turnSels) {
          const n = document.querySelectorAll(sel).length;
          if (n > 0) {
            turns = n;
            break;
          }
        }
        return {
          streaming,
          turns,
          quietMs: Date.now() - st.lastChange,
          mutations: st.mutations,
        };
      },
      { stopSel: SELECTORS.stopButton, turnSels: TURN_COUNT_SELECTORS },
    ),
    15000,
    'readDomState',
  );
}

/** Click "stop generating" — used to force the server to finalize a wedged turn. */
async function stopGeneration(page) {
  try {
    const btn = page.locator(SELECTORS.stopButton).first();
    if (await softly(btn.isVisible(), 5000, 'stop visible', false)) {
      await softly(btn.click({ force: true }), 5000, 'stop click');
      await sleep(1200);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * PRIMARY path: let the PAGE tell us when the turn is done, then read the answer
 * from the server exactly once.
 *
 * Why this shape (it is the whole point of the rewrite):
 *   The browser is already streaming the answer over ChatGPT's own SSE
 *   connection. Watching that via CDP costs no HTTP requests, so it is both
 *   free and faster than asking the backend. Polling /backend-api on a timer
 *   instead made cost grow with answer length — a 15-minute research run spent
 *   ~45 requests just to discover it had finished — which is what trips
 *   "too many requests", and a 429 then looks like a broken page and provokes a
 *   reload, spending even more. Cost is now flat: ~1 request per answer.
 *
 * Ladder, cheapest first:
 *   0. arm: watch (free) for the stop button to appear. Until streaming has been
 *        seen, a quiet page means "not started", so nothing is inferred from it.
 *        If it never appears within STREAM_START_MS, one API check settles it.
 *   1. armed + page goes still (stop button gone, no mutations for DOM_QUIET_MS)
 *        -> ONE API read confirms end_turn and returns clean markdown. This is
 *        the normal exit, and usually the only request made.
 *   2. DOM silent for IDLE_CHECK_MS -> one sparse API check to tell
 *        "server still working" from "stream died" (>= API_MIN_GAP_MS apart)
 *   3. silent past SILENT_RELOAD_MS -> reload once to re-establish the stream
 *   4. out of reloads -> return what we have, flagged truncated
 *
 * Never interrupts a turn the server reports as still generating, and never
 * reloads in response to a 429 — that would spend requests on a throttled
 * connection. A 429 only widens the gap before the next check.
 *
 * Returns { text, elapsed, truncated, partial, via, conversationId, notes } or
 * { apiBlocked: true } telling the caller to scrape the DOM instead.
 */
async function waitForAnswer(page, { convId, baseline, timeoutMs, prompt, resubmit, getPage }) {
  const start = Date.now();
  // May start out null: a brand-new chat often has no /c/<id> in the URL yet.
  // Every API step below is guarded on having it, and it is picked up for free
  // from the URL on each pass.
  let conv = convId || null;
  const promptSnippet = (prompt || '').trim().slice(0, 60);
  const notes = [];
  const note = (m) => {
    notes.push(m);
    log(m);
  };
  const elapsed = () => Math.round((Date.now() - start) / 1000);

  let bestText = '';
  let reloads = 0;
  let didResubmit = false;
  let apiRefusals = 0;
  let domFailures = 0;
  let researchNoted = false;

  // API budget bookkeeping. Anchored at start: the gap is measured from the moment
  // the turn began, so the heartbeat's first check lands IDLE_CHECK_MS in rather
  // than immediately.
  let lastApiAt = start;
  let apiCalls = 0;
  let rateLimitBackoff = 0;
  // Fingerprint of the DOM state we last confirmed, so a settled-but-unfinished
  // page is not re-confirmed until it actually changes again.
  let confirmedAt = -1;
  let lastActivityAt = Date.now();
  let sawStreaming = false;

  const canCallApi = () => Date.now() - lastApiAt >= API_MIN_GAP_MS + rateLimitBackoff;

  /**
   * Adopt the conversation id when the URL finally reveals it. Free.
   * As a last resort (URL never updated but the page has clearly answered) ask
   * the server for the newest conversation — one request, and only once.
   */
  let askedForNewest = false;
  const ensureConv = async (allowLookup) => {
    if (conv) return conv;
    const fromUrl = getConversationIdFromUrl(page.url());
    if (fromUrl) {
      conv = fromUrl;
      return conv;
    }
    if (!allowLookup || askedForNewest) return null;
    askedForNewest = true;
    lastApiAt = Date.now();
    apiCalls++;
    const r = await softly(callApi(page, { op: 'list', limit: 1 }), 20000, 'newest conv', null);
    // Safe despite concurrency: the daemon serializes asks, so no other turn of
    // ours is in flight and the newest conversation is the one we just created.
    if (r && r.ok && r.items && r.items[0] && r.items[0].id) {
      conv = r.items[0].id;
      note('URL never showed the conversation id — adopted newest conversation ' + conv);
    }
    return conv;
  };

  /** One authoritative read. Returns the poll snapshot, or null if unavailable. */
  const askServer = async (why) => {
    if (!conv) return null;
    lastApiAt = Date.now();
    apiCalls++;
    let snap = null;
    try {
      snap = await callApi(
        page,
        { op: 'poll', convId: conv, baselineIds: baseline.ids, baselineMax: baseline.maxTime, promptSnippet },
        20000,
      );
    } catch (e) {
      note(`server read failed (${why}): ${e.message}`);
      return null;
    }
    if (!snap) return null;
    if (snap.ok) {
      rateLimitBackoff = 0;
      apiRefusals = 0;
      if (snap.text) bestText = snap.text;
      return snap;
    }
    // 429 is the one status we must NOT treat as a broken page: reloading would
    // add requests to a connection that is already being throttled.
    if (snap.status === 429) {
      rateLimitBackoff = Math.min(rateLimitBackoff ? rateLimitBackoff * 2 : 60000, 300000);
      note(
        'ChatGPT rate-limited us (429) — backing off ' +
          `${Math.round((API_MIN_GAP_MS + rateLimitBackoff) / 1000)}s before the next check`,
      );
      return snap;
    }
    if (snap.status === 403 || snap.status === 404 || snap.status === 401) {
      apiRefusals++;
      return snap;
    }
    return snap;
  };

  // "Armed" = we know a turn is genuinely in flight, so a quiet DOM now means
  // finished rather than not-yet-started. Set by seeing the stop button, or by
  // the server saying so.
  let armed = false;
  let deadStrikes = 0;
  let armChecks = 0;
  // Once the server has confirmed it is generating, quiet stretches are expected
  // (deep research thinks for minutes between visible steps), so we stop reading
  // a stalled DOM as "finished" and let the sparse idle check handle it.
  let serverSaidGenerating = false;

  /**
   * The server says it is neither working nor finished. Waiting cannot fix that,
   * and re-asking would just burn requests. If nothing was captured, hand over to
   * DOM scraping — the answer may well be on screen even though the mapping walk
   * missed it (e.g. a baseline mismatch); otherwise return what we have.
   */
  const giveUp = (why) => {
    note(why);
    if (!bestText) return { apiBlocked: true, notes };
    return {
      text: bestText,
      elapsed: elapsed(),
      truncated: true,
      partial: true,
      via: 'aborted',
      conversationId: conv,
      apiCalls,
      notes,
    };
  };

  let pageLosses = 0;
  while (Date.now() - start < timeoutMs) {
    // The browser can die mid-answer (crash, OOM, window closed). ChatGPT keeps
    // generating server-side, so the answer is still there to be collected: get a
    // fresh page, reopen the conversation, and carry on with the same deadline.
    if (page.isClosed()) {
      if (!getPage || pageLosses >= 3) {
        throw new Error('browser page was closed while waiting for the answer');
      }
      pageLosses++;
      note(`browser page died — reattaching (${pageLosses}/3) and continuing to wait`);
      const fresh = await getPage();
      if (!fresh || fresh.isClosed()) {
        await sleep(2000);
        continue;
      }
      page = fresh;
      if (conv) {
        await softly(
          page.goto(`https://chatgpt.com/c/${conv}`, { waitUntil: 'domcontentloaded', timeout: 60000 }),
          65000,
          'reattach goto',
        );
      }
      // The observer lived in the old page, so treat this as fresh activity rather
      // than reading the new page's zero-mutation state as a stall.
      lastActivityAt = Date.now();
      confirmedAt = -1;
      continue;
    }

    // ---- free: what does the page say? ----
    let dom = null;
    try {
      dom = await readDomState(page);
      domFailures = 0;
    } catch {
      domFailures++;
    }

    if (dom) {
      if (dom.streaming) {
        sawStreaming = true;
        armed = true;
      }
      if (dom.quietMs < DOM_QUIET_MS) lastActivityAt = Date.now();
    }

    // Free: the URL may have grown a /c/<id> since last pass.
    if (!conv) await ensureConv(false);

    // (0) Turn hasn't visibly started. Give the stream STREAM_START_MS to appear
    // for free, then ask the server once whether it is working at all.
    if (!armed) {
      // The first couple of checks may be quick (they are one-offs, not a poll);
      // after that fall back to the normal floor so a page that never streams
      // cannot turn into a request loop. Always respect any 429 backoff.
      const armGap = (armChecks < 2 ? FIRST_CONFIRM_GAP_MS : API_MIN_GAP_MS) + rateLimitBackoff;
      // Neither signal available (no stop button seen AND no id in the URL) would
      // otherwise mean waiting out the whole timeout having asked nothing, so buy
      // an id once the stream has had its chance to appear.
      if (!conv && Date.now() - start >= STREAM_START_MS) await ensureConv(true);
      if (conv && Date.now() - start >= STREAM_START_MS && Date.now() - lastApiAt >= armGap) {
        armChecks++;
        const snap = await askServer('stream never started');
        if (snap && snap.ok) {
          if (snap.done) {
            return {
              text: snap.text,
              elapsed: elapsed(),
              truncated: false,
              partial: !!snap.partial,
              via: 'api-fast',
              conversationId: conv,
              apiCalls,
              notes,
            };
          }
          if (snap.generating) {
            armed = true;
            serverSaidGenerating = true;
            lastActivityAt = Date.now();
          } else if (!snap.userEchoed && !didResubmit && typeof resubmit === 'function') {
            note('prompt never reached the server — resubmitting once ...');
            try {
              await resubmit();
              didResubmit = true;
              lastActivityAt = Date.now();
            } catch (e) {
              note('resubmit failed: ' + e.message);
            }
          } else {
            // Prompt is there, server idle, no finished answer: the turn never
            // ran. Confirm once more (statuses flip a moment after submit), then
            // stop rather than polling for the rest of the timeout.
            deadStrikes++;
            if (deadStrikes >= 2) return giveUp('turn never started on the server');
          }
        }
        if (apiRefusals >= MAX_API_REFUSALS) {
          note(`backend API refused ${apiRefusals}x — falling back to DOM extraction`);
          return { apiBlocked: true, notes };
        }
      }
      await sleep(DOM_POLL_MS);
      continue;
    }

    // (1) Armed and the page has gone still: the stream is over. ONE API read
    // confirms end_turn and hands back clean markdown. This is the normal exit —
    // for an answer of any length it is the only request this function makes.
    //
    // quietNeeded = how long the page must hold still to count as finished. If the
    // stop button is gone, ChatGPT itself says the turn is over, so a short pause
    // is enough. If it is still showing, require a longer stall before doubting it,
    // and longer still once the server has confirmed it really is working.
    const quietNeeded = !dom || !dom.streaming
      ? DOM_QUIET_MS
      : serverSaidGenerating
        ? RESEARCH_STALL_MS
        : STREAM_STALL_MS;
    const settled = dom && dom.turns > 0 && dom.quietMs >= quietNeeded;
    const fresh = dom && dom.mutations !== confirmedAt;
    if (settled && fresh && (apiCalls === 0 || canCallApi())) {
      confirmedAt = dom.mutations;
      await ensureConv(true);
      const snap = await askServer('stream ended');
      if (!snap && !conv) {
        // No id and no way to get one: the DOM is all we have.
        note('no conversation id available — falling back to DOM extraction');
        return { apiBlocked: true, notes };
      }
      if (snap && snap.ok) {
        if (snap.done) {
          return {
            text: snap.text,
            elapsed: elapsed(),
            truncated: false,
            partial: !!snap.partial,
            via: 'dom+api',
            conversationId: conv,
            apiCalls,
            notes,
          };
        }
        if (snap.generating) {
          // Client stream stopped but the server is still going (long research
          // shows this). Stay quiet and let it work.
          serverSaidGenerating = true;
          lastActivityAt = Date.now();
          if (!researchNoted) {
            researchNoted = true;
            note(
              'ChatGPT is still working (long research/thinking run) — waiting quietly, ' +
                `timeout ${Math.round(timeoutMs / 60000)}min`,
            );
          }
        } else if (snap.userEchoed) {
          // Not generating, not finished: the turn ended without completing.
          // Waiting cannot help, so give up quickly rather than after minutes.
          deadStrikes++;
          if (deadStrikes >= 2) return giveUp('turn ended without completing');
        }
      }
      if (apiRefusals >= MAX_API_REFUSALS) {
        note(`backend API refused ${apiRefusals}x — falling back to DOM extraction`);
        return { apiBlocked: true, notes };
      }
    }

    const silentFor = Date.now() - lastActivityAt;

    // (2) Heartbeat. The settle path above can miss the end of a turn entirely:
    // while ChatGPT researches it animates a progress UI, so the DOM never goes
    // quiet and a silence-triggered check would never fire — the turn would run to
    // the full timeout even after the answer landed. So check in on a slow clock
    // regardless of what the page is doing, gated so it can never exceed roughly
    // one request per minute.
    const sinceApi = Date.now() - lastApiAt;
    if (armed && conv && sinceApi >= IDLE_CHECK_MS && canCallApi()) {
      const why = silentFor >= IDLE_CHECK_MS
        ? 'dom silent ' + Math.round(silentFor / 1000) + 's'
        : 'heartbeat after ' + Math.round(sinceApi / 1000) + 's';
      const snap = await askServer(why);
      if (snap && snap.ok) {
        if (snap.done) {
          return {
            text: snap.text,
            elapsed: elapsed(),
            truncated: false,
            partial: !!snap.partial,
            via: 'api-idle',
            conversationId: conv,
            apiCalls,
            notes,
          };
        }
        if (snap.generating) {
          serverSaidGenerating = true;
          lastActivityAt = Date.now();
          if (!researchNoted) {
            researchNoted = true;
            note(
              'ChatGPT is still working (long research/thinking run) — waiting quietly, ' +
                `timeout ${Math.round(timeoutMs / 60000)}min`,
            );
          }
        }
      }
      if (apiRefusals >= MAX_API_REFUSALS) {
        note(`backend API refused ${apiRefusals}x — falling back to DOM extraction`);
        return { apiBlocked: true, notes };
      }
    }

    // (3) Truly nothing for a long time, or the page itself is unreadable:
    // reload to re-establish the stream. Last resort, and never while the server
    // reports progress — the checks above reset the clock in that case.
    const wedged = domFailures >= 5;
    if ((silentFor >= SILENT_RELOAD_MS || wedged) && reloads < MAX_STALL_RELOADS) {
      note(
        wedged
          ? 'page unreadable — reloading to recover ...'
          : `no activity for ${Math.round(silentFor / 1000)}s — reloading once to re-sync ` +
              `(${reloads + 1}/${MAX_STALL_RELOADS}) ...`,
      );
      await reloadPage(page);
      reloads++;
      domFailures = 0;
      lastActivityAt = Date.now();
      confirmedAt = -1;
      continue;
    }

    // (4) Out of reloads and still silent: take the best text we have. We do NOT
    // click stop — that would kill a turn the server may still be finishing.
    if (silentFor >= SILENT_RELOAD_MS && reloads >= MAX_STALL_RELOADS) {
      const snap = canCallApi() ? await askServer('final') : null;
      if (snap && snap.ok && snap.done) {
        return {
          text: snap.text,
          elapsed: elapsed(),
          truncated: false,
          partial: !!snap.partial,
          via: 'api-final',
          conversationId: conv,
          apiCalls,
          notes,
        };
      }
      if (snap && snap.ok && snap.generating) {
        lastActivityAt = Date.now();
        await sleep(DOM_POLL_MS);
        continue;
      }
      note('no activity and no server progress — returning partial text');
      return {
        text: bestText,
        elapsed: elapsed(),
        truncated: true,
        partial: !!bestText,
        via: 'stalled',
        conversationId: conv,
        apiCalls,
        notes,
      };
    }

    await sleep(DOM_POLL_MS);
  }

  // Hard timeout. One last cheap attempt to salvage a complete answer.
  const snap = await askServer('timeout');
  if (snap && snap.ok && snap.done) {
    return {
      text: snap.text,
      elapsed: elapsed(),
      truncated: false,
      partial: !!snap.partial,
      via: 'api-timeout-ok',
      conversationId: conv,
      apiCalls,
      notes,
    };
  }
  if (sawStreaming || (snap && snap.ok && snap.generating)) {
    note('timed out while ChatGPT was still generating — answer is incomplete');
  }
  return {
    text: bestText,
    elapsed: elapsed(),
    truncated: true,
    partial: !!bestText,
    via: 'timeout',
    conversationId: conv,
    apiCalls,
    notes,
  };
}

/**
 * FALLBACK path: scrape the DOM. Only used when the backend API is unreachable
 * (e.g. blocked/403), since the DOM interleaves reasoning panels with the answer
 * and its "is it still streaming?" signals are unreliable.
 *
 * Strategy (robust to the / -> /c/<id> navigation that resets the DOM):
 *   1. Wait until a NEW assistant turn appears (turn count increases or URL changes).
 *   2. Poll the latest answer until the text stops changing AND streaming finished.
 */
async function captureResponseDom(page, timeoutMs, baseline) {
  const start = Date.now();
  if (!baseline) baseline = await getBaseline(page);

  // Tunables. The DOM path is a FALLBACK (the server-API path above is primary)
  // and it cannot see the server's own "still generating" flag, so we must be
  // PATIENT: deep-research answers pause for minutes between visible updates.
  // Aggressive "unchanged for a few seconds => done" heuristics would hand back a
  // half-finished answer, so completion is decided by the stop button disappearing,
  // with a long safety net only to avoid hanging forever. Polling and reloading are
  // kept slow so we don't hammer ChatGPT ("too many requests").
  const phase1ReloadMs = 60000; // Phase 1 stalled this long -> reload (rare)
  const stuckReloadMs = 120000; // Phase 2 stuck on placeholder this long -> reload (very rare)
  const pollInterval = 3000;
  const confirmMs = 4000; // stop button gone + unchanged this long -> done
  const hardMs = 120000; // unchanged this long -> give up (truncated) — true safety net

  // ---- Phase 1: wait for the NEW answer to start appearing ----
  //   - new chat  : URL changes from / to /c/<id>
  //   - continuing: turn count increases, or latest answer text changes, or a
  //                 "thinking" placeholder appears for the new turn
  // If nothing happens for a while, the answer may already exist server-side but
  // the DOM is stale — reload the page to re-fetch it from the server.
  let phase1Reloads = 0;
  let lastReloadAt = start;
  let sawNew = false;
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    const turns = await getTurnCount(page);
    const snap = await getLatestAnswer(page);
    const t = snap.text;
    const urlChanged = url !== baseline.url && turns > 0;
    const turnsIncreased = turns > baseline.turns;
    const newRealText = t && t !== baseline.text && !isPlaceholderText(t);
    const thinkingAppeared = t && t !== baseline.text && isPlaceholderText(t);
    if (urlChanged || turnsIncreased || newRealText || thinkingAppeared) {
      sawNew = true;
      break;
    }
    if (phase1Reloads < 1 && Date.now() - lastReloadAt >= phase1ReloadMs) {
      log('no response yet — reloading page to re-fetch from server ...');
      await reloadPage(page);
      phase1Reloads++;
      lastReloadAt = Date.now();
    }
    await page.waitForTimeout(2000);
  }
  if (!sawNew) throw new Error('Timed out waiting for ChatGPT to start responding.');

  // ---- Phase 2: wait for the answer to finish ----
  //   primary  : stop button gone + text unchanged for confirmMs
  //   recovery : stuck on "thinking"/empty a VERY long time -> reload to pull the
  //              final answer down (rare; long thinking pauses are normal)
  //   safety   : hardMs cap so we never hang
  let lastText = '';
  let lastChange = Date.now();
  let lastHtml = '';
  let finishedCleanly = false;
  let didStuckReload = false;
  while (Date.now() - start < timeoutMs) {
    const snap = await getLatestAnswer(page);
    const text = snap.text;
    lastHtml = snap.html;
    if (text !== lastText) {
      lastText = text;
      lastChange = Date.now();
    }
    const unchangedFor = Date.now() - lastChange;
    const placeholder = isPlaceholderText(text);

    if (!placeholder && text.length > 0) {
      const streaming = await isStreaming(page);
      // Primary "done" signal: the stop button is gone AND the text has been stable
      // for confirmMs. We deliberately do NOT treat a short pause as final (research
      // answers pause for minutes), so there is no short fast-path here.
      if (!streaming && unchangedFor >= confirmMs) {
        finishedCleanly = true;
        break;
      }
      if (unchangedFor >= hardMs) {
        finishedCleanly = true; // long safety net — never hang forever
        break;
      }
    } else if (!didStuckReload && Date.now() - start >= stuckReloadMs) {
      // Only a placeholder/empty for a long time: the finished answer is likely
      // already on the server — reload to re-fetch it.
      log('still thinking/empty after ' + Math.round(stuckReloadMs / 1000) + 's — reloading to re-fetch ...');
      await reloadPage(page);
      didStuckReload = true;
      lastChange = Date.now();
    }
    await page.waitForTimeout(pollInterval);
  }

  const finalSnap = await getLatestAnswer(page);
  const finalText = (finalSnap.text || lastText || '').trim();
  return {
    text: finalText,
    html: finalSnap.html || lastHtml || '',
    elapsed: Math.round((Date.now() - start) / 1000),
    truncated: !finishedCleanly || isPlaceholderText(finalText),
  };
}

// ---------------------------------------------------------------------------
// Server-state API (ground truth)
//
// Everything below runs INSIDE the page so the logged-in session cookies are
// used automatically. We talk to /backend-api/conversation/<id> rather than
// scraping the DOM because the server is authoritative:
//
//   * the DOM can stop updating while the server finishes the answer (the exact
//     "stuck" case) — the API still returns the completed text;
//   * the DOM interleaves reasoning panels ("Thinking", reasoning_recap) with
//     the real answer, so "last .markdown block" grabs the wrong node;
//   * parts[] gives us clean markdown instead of rendered innerText.
//
// Field semantics verified against live responses:
//   real answer      -> role=assistant, recipient="all", content_type="text"
//   finished         -> end_turn === true && status === "finished_successfully"
//   reasoning recap  -> content_type="reasoning_recap"  (skip; can have a LATER
//                       create_time than the answer, so never sort-by-time)
//   web-search call  -> recipient="genui.search"        (skip)
//   generating       -> async_status = 3, becomes null when the turn ends
// ---------------------------------------------------------------------------

/** Single page-side entry point for all backend calls (token cached per page). */
async function pageApi(args) {
  const { op } = args;
  const getToken = async (force) => {
    if (!force && window.__askChatgptToken) return window.__askChatgptToken;
    const r = await fetch('/api/auth/session', { credentials: 'include' });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    window.__askChatgptToken = j.accessToken || null;
    return window.__askChatgptToken;
  };
  const call = async (apiPath, method = 'GET', body = null) => {
    const doFetch = async (token) => {
      const headers = {
        'oai-did': (document.cookie.match(/(?:^|;\s*)oai-did=([^;]+)/) || [])[1] || '',
      };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (body) headers['Content-Type'] = 'application/json';
      return fetch(apiPath, {
        method,
        credentials: 'include',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    };
    let res = await doFetch(await getToken(false));
    if (res.status === 401 || res.status === 403) res = await doFetch(await getToken(true));
    const txt = await res.text();
    let json = null;
    try {
      json = JSON.parse(txt);
    } catch {
      /* non-JSON (HTML error page) */
    }
    return { ok: res.ok, status: res.status, json };
  };
  // --- shared predicates -------------------------------------------------
  const textOf = (m) => {
    const parts = m && m.content && m.content.parts;
    if (!Array.isArray(parts)) return '';
    return parts.filter((p) => typeof p === 'string').join('').trim();
  };
  // A node that is genuinely part of the visible answer.
  const isAnswerNode = (m) => {
    if (!m || !m.author || m.author.role !== 'assistant') return false;
    if (m.recipient !== 'all') return false;
    const ct = m.content && m.content.content_type;
    if (ct !== 'text' && ct !== 'multimodal_text') return false;
    if (m.metadata && m.metadata.is_visually_hidden_from_conversation === true) return false;
    return true;
  };
  const answerNodes = (mapping) =>
    Object.values(mapping || {})
      .filter((n) => n && n.message && isAnswerNode(n.message))
      .map((n) => ({
        id: n.id,
        text: textOf(n.message),
        status: n.message.status,
        endTurn: n.message.end_turn,
        channel: n.message.channel === undefined ? null : n.message.channel,
        createTime: n.message.create_time || 0,
      }));
  const userNodes = (mapping) =>
    Object.values(mapping || {})
      .filter((n) => n && n.message && n.message.author && n.message.author.role === 'user')
      .map((n) => ({ id: n.id, text: textOf(n.message), createTime: n.message.create_time || 0 }));

  // --- operations --------------------------------------------------------
  if (op === 'list') {
    const r = await call(`/backend-api/conversations?offset=0&limit=${args.limit}&order=updated`);
    if (!r.ok) return { ok: false, status: r.status, items: [] };
    return {
      ok: true,
      items: ((r.json && r.json.items) || []).map((it) => ({
        id: it.id,
        title: it.title || '',
        updated: it.update_time || '',
      })),
    };
  }

  if (op === 'title') {
    const r = await call('/backend-api/conversation/' + args.convId);
    return { ok: r.ok, status: r.status, title: (r.json && r.json.title) || '' };
  }

  if (op === 'rename') {
    const r = await call('/backend-api/conversation/' + args.convId, 'PATCH', { title: args.title });
    return { ok: r.ok, status: r.status };
  }

  // Snapshot which answers already exist, so we only accept a NEW one. This is
  // what makes multi-turn safe: in a long conversation the previous answer is
  // still present, and without a baseline we would return it immediately.
  if (op === 'baseline') {
    const r = await call('/backend-api/conversation/' + args.convId);
    if (!r.ok) return { ok: false, status: r.status, ids: [], maxTime: 0 };
    const nodes = answerNodes(r.json && r.json.mapping);
    return {
      ok: true,
      status: r.status,
      ids: nodes.map((n) => n.id),
      maxTime: nodes.reduce((mx, n) => Math.max(mx, n.createTime), 0),
    };
  }

  if (op === 'poll') {
    const r = await call('/backend-api/conversation/' + args.convId);
    if (!r.ok) return { ok: false, status: r.status };
    const j = r.json || {};
    const known = new Set(args.baselineIds || []);
    const all = answerNodes(j.mapping);

    // Only nodes that did not exist before this turn count as "the answer".
    // create_time is a secondary guard for the rare case where a node id is
    // reused/re-parented mid-stream.
    let fresh = all.filter((n) => !known.has(n.id) && n.createTime >= (args.baselineMax || 0) - 1);
    if (!fresh.length) fresh = all.filter((n) => !known.has(n.id));

    // Newest fresh node wins. (Safe here: every candidate already passed
    // isAnswerNode, so reasoning_recap can't win on a later timestamp.)
    let best = null;
    for (const n of fresh) if (!best || n.createTime > best.createTime) best = n;

    // Did the server actually receive our prompt? After a recovery reload we use
    // this to tell "prompt lost, resubmit" apart from "still generating".
    const snippet = (args.promptSnippet || '').trim();
    const userEchoed = snippet
      ? userNodes(j.mapping).some((u) => !known.has(u.id) && u.text.includes(snippet))
      : true;

    const finished =
      !!best && best.endTurn === true &&
      (best.status === 'finished_successfully' || best.status === 'finished_partial_completion');

    // ---- liveness signals -------------------------------------------------
    // During deep research the ANSWER node does not exist for minutes: ChatGPT is
    // emitting search calls and reasoning instead. Watching only the answer text
    // would look like a total stall and trip the watchdog on a healthy run, so we
    // also report whether the server is demonstrably still working.
    const allNodes = Object.values(j.mapping || {}).filter((n) => n && n.message);
    const nodeCount = allNodes.length;
    const maxCreate = allNodes.reduce(
      (mx, n) => Math.max(mx, (n.message && n.message.create_time) || 0),
      0,
    );
    const anyInProgress = allNodes.some((n) => n.message && n.message.status === 'in_progress');
    // async_status is non-null (observed: 3) while a turn is in flight.
    const asyncActive = j.async_status !== null && j.async_status !== undefined;
    // Total assistant bytes, incl. reasoning/tool nodes — grows during research
    // even before the final answer node appears.
    const workBytes = allNodes.reduce((sum, n) => sum + textOf(n.message).length, 0);

    return {
      ok: true,
      nodeCount,
      maxCreate,
      anyInProgress,
      asyncActive,
      workBytes,
      generating: anyInProgress || asyncActive,
      status: r.status,
      found: !!best,
      done: finished,
      partial: !!best && best.status === 'finished_partial_completion',
      text: best ? best.text : '',
      len: best ? best.text.length : 0,
      nodeId: best ? best.id : null,
      nodeStatus: best ? best.status : null,
      endTurn: best ? best.endTurn : null,
      asyncStatus: j.async_status === undefined ? null : j.async_status,
      isReadOnly: j.is_read_only === undefined ? null : j.is_read_only,
      userEchoed,
    };
  }

  return { ok: false, error: 'unknown op ' + op };
}

/** Run a page-side API op with a hard deadline. */
function callApi(page, args, timeoutMs = PAGE_OP_TIMEOUT) {
  return withTimeout(page.evaluate(pageApi, args), timeoutMs, 'api:' + args.op);
}

const AGENT_PREFIX = '[AGENT] ';

function getConversationIdFromUrl(url) {
  const m = (url || '').match(/\/c\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

async function getConversationId(page) {
  return getConversationIdFromUrl(page.url());
}

/** Compute the desired "[AGENT] <base>" title, avoiding a doubled prefix. */
function agentTitle(prompt, currentTitle) {
  let base;
  if (currentTitle && currentTitle.trim()) {
    base = currentTitle.trim();
  } else {
    base = (prompt || '').split('\n')[0].trim().replace(/\s+/g, ' ').slice(0, 60) || 'conversation';
  }
  base = base.replace(/^\[AGENT\]\s*/i, '').trim();
  return AGENT_PREFIX + base;
}

async function fetchConversationTitle(page, id) {
  const r = await softly(callApi(page, { op: 'title', convId: id }), PAGE_OP_TIMEOUT, 'title', null);
  return (r && r.title) || '';
}

async function renameConversation(page, id, title) {
  const r = await softly(
    callApi(page, { op: 'rename', convId: id, title }),
    PAGE_OP_TIMEOUT,
    'rename',
    { ok: false, error: 'timeout' },
  );
  return r || { ok: false, error: 'no response' };
}

async function listConversations(page, limit) {
  const r = await softly(
    callApi(page, { op: 'list', limit: limit || 20 }),
    PAGE_OP_TIMEOUT,
    'list',
    null,
  );
  return (r && r.items) || [];
}

/**
 * Make sure the current conversation carries a single "[AGENT] " prefix.
 * Returns { id, title, renamed }.
 */
async function ensureAgentTitle(page, { prompt, explicitTitle, isNew }) {
  const id = await getConversationId(page);
  if (!id) return { id: null, title: null, renamed: false };
  // A follow-up was already prefixed on its first turn, so re-deriving the title
  // just recomputes the value it already has. Skipping the read saves a request on
  // every follow-up, which is worth more than echoing back a title we didn't touch.
  if (!isNew && !explicitTitle) return { id, title: null, renamed: false };
  let target;
  if (explicitTitle) {
    target = explicitTitle.startsWith('[AGENT]') ? explicitTitle : AGENT_PREFIX + explicitTitle;
  } else {
    // New chat: ChatGPT's own auto-title never carries our prefix, so a rename is
    // certain and reading the current title first would be a wasted request.
    target = agentTitle(prompt, '');
  }
  if (!isNew) {
    const current = await fetchConversationTitle(page, id);
    if (current === target) return { id, title: target, renamed: false };
  }
  const r = await renameConversation(page, id, target);
  if (!r.ok) log('rename failed:', JSON.stringify(r));
  return { id, title: target, renamed: !!r.ok };
}

// ---------------------------------------------------------------------------
// Named sessions
//
// Multi-turn across SEPARATE CLI invocations: `ask "..." -s work` maps the name
// "work" to a conversation id on disk, so a later `ask "..." -s work` continues
// that same thread. Kept in the CLI (not the daemon) so it survives daemon
// restarts and machine reboots.
// ---------------------------------------------------------------------------

function readSessions() {
  try {
    const j = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeSessions(obj) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // Write-then-rename: a reader either sees the old file or the new one, never a
  // half-written one. Matters because several agents share this file.
  const tmp = SESSIONS_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SESSIONS_FILE);
}

function getSessionConv(name) {
  if (!name) return null;
  const s = readSessions()[name];
  return (s && s.conversationId) || null;
}

/**
 * Mutate sessions.json under an exclusive lock.
 *
 * Read-modify-write without one loses entries: two agents finishing at the same
 * moment both read the old map, and the second write drops the first agent's
 * session. The lock is a directory created with mkdir (atomic everywhere), and a
 * stale one is broken after LOCK_STALE_MS so a killed process can't wedge it.
 */
const LOCK_DIR = SESSIONS_FILE + '.lock';
const LOCK_STALE_MS = 15000;

function withSessionLock(fn) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const deadline = Date.now() + 5000;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(LOCK_DIR);
      held = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') break;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
      } catch {
        continue; // vanished — try again
      }
      if (age > LOCK_STALE_MS) {
        try {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
        } catch {
          /* someone else got there first */
        }
        continue;
      }
      // Busy-wait briefly; this lock is held for microseconds in practice.
      const until = Date.now() + 50;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function saveSessionConv(name, conversationId, title) {
  if (!name || !conversationId) return;
  withSessionLock(() => {
    // Re-read INSIDE the lock: another agent may have added a session since we
    // started, and its entry must survive our write.
    const all = readSessions();
    all[name] = { conversationId, title: title || all[name]?.title || '', updated: new Date().toISOString() };
    writeSessions(all);
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdLogin(opts) {
  await stopDaemon(); // free the profile lock held by the daemon (if any)
  log('opening browser — please log into ChatGPT in the window...');
  const { ctx, page } = await launch(false, opts.chromium); // login always headed
  try {
    await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Give the user up to 5 minutes to complete login.
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      try {
        if (await isCloudflareChallenge(page)) continue;
        await dismissOverlays(page);
        if (await composerVisible(page)) {
          log('logged in successfully. Session saved to', PROFILE_DIR);
          console.log('OK: logged in');
          return;
        }
      } catch {
        /* keep waiting */
      }
    }
    throw new Error('Timed out waiting for login. Run "login" again and complete it in the window.');
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function cmdStatus(opts) {
  const s = readDaemonState();
  if (!s || !isPidAlive(s.pid) || !(await healthCheck(s.port))) {
    console.log('DAEMON_NOT_RUNNING');
    log('it auto-starts on the first "ask". Start now: node chatgpt.mjs start');
    return;
  }
  const r = await rpc(s.port, '/health', {}).catch(() => null);
  if (!r) {
    console.log('DAEMON_UNHEALTHY');
    return;
  }
  console.log(r.loggedIn ? 'OK: logged in' : 'NOT_LOGGED_IN');
  log(
    'daemon on port ' + s.port + ', pid ' + s.pid +
      (r.currentConv ? ', current conv ' + r.currentConv : ''),
  );
  if (!r.loggedIn) log('run: node chatgpt.mjs stop && node chatgpt.mjs sync && node chatgpt.mjs start');
}

async function cmdAsk(prompt, opts) {
  if (!prompt || !prompt.trim()) {
    throw new Error('empty prompt. Usage: chatgpt.mjs ask "<your question>"');
  }
  const s = await ensureDaemon(opts);
  // A named session continues its own conversation unless --new rebinds it.
  const sessionConv = opts.newChat ? null : getSessionConv(opts.session);
  if (opts.session && sessionConv) log(`session "${opts.session}" -> conversation ${sessionConv}`);
  // Asks are served one at a time (single browser tab). If other agents are
  // already waiting, our own answer time must be measured on TOP of their runs,
  // or we'd abandon the request while still queued and never get asked at all.
  const ahead = typeof s.queueDepth === 'number' ? s.queueDepth : 0;
  if (ahead > 0) {
    log(
      `${ahead} other ask(s) are ahead of us in the queue — waiting our turn ` +
        '(the browser has one tab, so asks are serialized)',
    );
  }
  const budget = (opts.timeout || DEFAULT_TIMEOUT) * (1 + ahead) + 180000;
  const r = await rpc(
    s.port,
    '/ask',
    {
      prompt,
      conv: opts.conv || sessionConv,
      title: opts.title,
      model: opts.model,
      forceNew: opts.newChat === true,
      // Only --no-new asks to reuse whatever chat the shared daemon has open.
      // Without it, an ask with no session/conv gets its own new conversation, so
      // concurrent agents cannot land in each other's threads.
      continueCurrent: opts.newChat === false,
      rename: !opts.noRename,
      timeout: opts.timeout,
      html: opts.html,
      dom: opts.dom,
      images: opts.images && opts.images.length ? opts.images : undefined,
    },
    budget,
  );
  if (r.html) log('--- HTML ---\n' + r.html);
  // Surface what the daemon had to do to get the answer (stalls, reloads, retries).
  for (const n of r.notes || []) log('recovery: ' + n);
  if (opts.save) {
    fs.writeFileSync(opts.save, r.answer, 'utf8');
    log('saved answer to', opts.save);
  }
  if (opts.session && r.conversationId) {
    saveSessionConv(opts.session, r.conversationId, r.title);
    log(`session "${opts.session}" saved — continue with: -s ${opts.session}`);
  }
  if (r.truncated) {
    log(
      'warning: response may be incomplete' +
        (r.via === 'api-stalled'
          ? ' (server stalled mid-answer; generation was stopped and partial text returned)'
          : ' (still generating when the timeout hit — raise --timeout)'),
    );
  } else if (r.partial) {
    // The turn did end, but ChatGPT itself marked it as cut short.
    log('warning: ChatGPT ended this turn early (partial completion) — consider re-asking');
  }
  log(
    `done in ${r.elapsed}s via ${r.via}` +
      // Requests spent on the backend API — the number that decides whether
      // ChatGPT starts rate-limiting us, so it stays visible.
      (typeof r.apiCalls === 'number' ? ` | api calls: ${r.apiCalls}` : '') +
      ` | conversation_id: ${r.conversationId || '?'}`,
  );
  if (r.title) log('title: ' + r.title);
  log(
    'follow up with: ' +
      (opts.session ? `-s ${opts.session}` : '--conv ' + (r.conversationId || '<id>')),
  );

  // An incomplete answer must be impossible to mistake for a finished one.
  // stderr alone is not enough: a caller that reads stdout would happily treat
  // half an answer as the final word and move on to the next question. So we
  // ALSO mark stdout and exit non-zero. Complete answers stay perfectly clean.
  if (r.truncated) {
    console.log(
      `[INCOMPLETE ANSWER — ChatGPT was still working after ${r.elapsed}s. ` +
        'The text below is PARTIAL. Do not treat it as final and do not ask a ' +
        'follow-up yet: re-run with a larger --timeout, or re-ask.]\n',
    );
  }
  console.log(r.answer);
  if (r.truncated) process.exit(EXIT_INCOMPLETE);
}

async function cmdChat(opts) {
  const s = await ensureDaemon(opts);
  log('interactive chat — the browser stays open between questions.');
  log('type a prompt + Enter. empty line / "exit" / Ctrl+D ends input (browser keeps running).');
  if (opts.conv) log('resuming conversation ' + opts.conv);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let first = true;
  let convId = opts.conv || (opts.newChat ? null : getSessionConv(opts.session));
  if (convId) log('continuing conversation ' + convId);
  for await (const raw of rl) {
    const prompt = raw.trim();
    if (!prompt || prompt === 'exit' || prompt === 'quit') break;
    try {
      const r = await rpc(
        s.port,
        '/ask',
        {
          prompt,
          // After the first turn we pin the conversation explicitly, so the thread
          // is stable even if something else touched the daemon in between.
          conv: convId,
          title: opts.title,
          model: opts.model,
          forceNew: opts.newChat === true && first,
          rename: !opts.noRename,
          timeout: opts.timeout,
          images: opts.images && opts.images.length ? opts.images : undefined,
        },
        (opts.timeout || DEFAULT_TIMEOUT) + 180000,
      );
      if (r.conversationId) {
        convId = r.conversationId;
        if (opts.session) saveSessionConv(opts.session, convId, r.title);
      }
      log(`conversation_id: ${r.conversationId || '?'}` + (r.title ? ` | title: ${r.title}` : ''));
      console.log(r.answer);
      console.log('');
    } catch (e) {
      log('ERROR:', e.message);
    }
    first = false;
  }
  log('input ended. browser still running — run "node chatgpt.mjs stop" to close it.');
}

async function cmdList(opts) {
  const s = await ensureDaemon(opts);
  const r = await rpc(s.port, '/list', { limit: opts.limit, agentOnly: opts.agentOnly });
  if (opts.json) {
    console.log(JSON.stringify(r.items, null, 2));
    return;
  }
  if (!r.items.length) {
    console.log('(no conversations)');
    return;
  }
  for (const it of r.items) console.log(`${it.id}\t${it.title}`);
}

async function cmdSessions(opts) {
  const forget = opts._[0] === '--forget' ? opts._[1] : null;
  if (forget) {
    const gone = withSessionLock(() => {
      const all = readSessions();
      if (!all[forget]) return false;
      delete all[forget];
      writeSessions(all);
      return true;
    });
    console.log(gone ? 'forgot session: ' + forget : 'no such session: ' + forget);
    return;
  }
  const all = readSessions();
  const names = Object.keys(all);
  if (opts.json) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }
  if (!names.length) {
    console.log('(no named sessions) — create one with: ask "..." -s <name>');
    return;
  }
  for (const n of names) {
    console.log(`${n}\t${all[n].conversationId}\t${all[n].title || ''}`);
  }
}

async function cmdStart(opts) {
  const s = await ensureDaemon(opts);
  const r = await rpc(s.port, '/health', {});
  console.log('OK: daemon running on port ' + s.port + (r.loggedIn ? ' (logged in)' : ' (NOT logged in)'));
}

async function cmdStop(opts) {
  const stopped = await stopDaemon(opts);
  console.log(stopped ? 'OK: daemon stopped, browser closed' : 'daemon was not running');
}

// ---------------------------------------------------------------------------
// Daemon: keeps ONE browser open so the agent can ask many follow-up questions
// without relaunching, and controls when the browser closes.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readDaemonState() {
  try {
    const s = JSON.parse(fs.readFileSync(DAEMON_STATE, 'utf8'));
    if (s && s.port && s.pid) return s;
  } catch {
    /* no state */
  }
  return null;
}

function writeDaemonState(port, pid) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(DAEMON_STATE, JSON.stringify({ port, pid }), { mode: 0o600 });
}

function clearDaemonState() {
  try {
    fs.unlinkSync(DAEMON_STATE);
  } catch {
    /* ignore */
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Returns the parsed /health payload, or null if the daemon isn't answering. */
async function healthCheck(port, timeoutMs = 3000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    const json = await res.json();
    return json && json.ok === true ? json : null;
  } catch {
    return null;
  }
}

async function rpc(port, method, params, timeoutMs) {
  // Always bounded: if the daemon wedges, the CLI still returns.
  const ctrl = new AbortController();
  const cap = timeoutMs || 60000;
  const t = setTimeout(() => ctrl.abort(), cap);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`daemon RPC ${method} timed out after ${cap}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(json.error || `daemon RPC ${method} failed`);
  return json;
}

async function stopDaemon() {
  const s = readDaemonState();
  if (!s) return false;
  try {
    await rpc(s.port, '/stop', {});
  } catch {
    /* daemon may already be gone */
  }
  if (isPidAlive(s.pid)) {
    try {
      process.kill(s.pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
  clearDaemonState();
  return true;
}

async function ensureDaemon(opts) {
  const s = readDaemonState();
  if (s && isPidAlive(s.pid)) {
    const h = await healthCheck(s.port);
    // queueDepth travels with the state so the caller can size its own deadline
    // around asks that are already in flight.
    if (h) return { ...s, queueDepth: h.queueDepth || 0 };
  }
  clearDaemonState(); // stale
  log('starting daemon (opening Chrome and keeping it open) ...');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = fs.openSync(DAEMON_LOG, 'a');
  const args = [__filename, 'daemon'];
  if (opts.headless) args.push('--headless');
  if (opts.chromium) args.push('--chromium');
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const st = readDaemonState();
    if (st) {
      const h = await healthCheck(st.port);
      if (h) return { ...st, queueDepth: h.queueDepth || 0 };
    }
  }
  throw new Error('daemon failed to start — see ' + DAEMON_LOG);
}

/** Detect ChatGPT's "something went wrong" / rate-limit banners. */
async function detectErrorBanner(page) {
  return softly(
    page.evaluate(() => {
      const pats = [
        /something went wrong/i,
        /error in message stream/i,
        /network error/i,
        /too many requests/i,
        /rate limit/i,
        /出错了|发生错误|网络错误|请求过多/,
      ];
      const nodes = document.querySelectorAll(
        '[role="alert"], .text-error, [data-testid*="error"], div.text-red-500, div.text-token-text-error',
      );
      for (const n of nodes) {
        const t = (n.textContent || '').trim();
        if (t && pats.some((p) => p.test(t))) return t.slice(0, 200);
      }
      return null;
    }),
    10000,
    'error banner',
    null,
  );
}

/**
 * Core single-turn operation, run inside the daemon against the persistent page.
 *
 * Multi-turn: pass `conv` (or a named session, resolved by the CLI) to continue a
 * thread; otherwise a fresh chat is started. The daemon's last conversation is
 * only reused when the caller explicitly asks with `continueCurrent` — several
 * agents share one daemon, and silently inheriting whichever chat happened to be
 * open last would append one agent's question to another's thread.
 * Completion is decided by the page's own stream, confirmed once against SERVER
 * state (see waitForAnswer); the DOM is only scraped if the API is unavailable.
 */
async function doAsk(pageArg, state, p, queuedMs = 0) {
  // Reassignable: if the browser dies mid-answer the daemon relaunches it, and the
  // steps after the wait (conversation id, title) must use the live page.
  let page = pageArg;
  const prompt = (p.prompt || '').trim();
  if (!prompt) throw new Error('empty prompt');
  const forceNew = p.forceNew === true;
  const inherited = p.continueCurrent === true && !forceNew ? state.currentConv : null;
  const conv = p.conv || inherited || null;
  const isNew = !conv;
  const targetUrl = conv ? `https://chatgpt.com/c/${conv}` : CHATGPT_URL;

  const cur = page.url();
  if (!(conv && cur.includes(`/c/${conv}`))) {
    // Retry once: a transient navigation failure shouldn't fail the whole ask.
    let navOk = false;
    for (let attempt = 0; attempt < 2 && !navOk; attempt++) {
      try {
        await withTimeout(
          page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }),
          65000,
          'goto ' + targetUrl,
        );
        navOk = true;
      } catch (e) {
        log(`navigation failed (attempt ${attempt + 1}): ${e.message}`);
        await sleep(1500);
      }
    }
    if (!navOk) throw new Error('could not open ' + targetUrl);
    await sleep(1500);
  }
  if (await isCloudflareChallenge(page)) {
    throw new Error('Cloudflare is blocking the browser (avoid --headless for ChatGPT).');
  }
  await dismissOverlays(page);
  // Navigating to the root URL already gives a fresh chat; only force a new one
  // if the composer somehow isn't there.
  if (isNew && !(await composerVisible(page))) await startNewChat(page);
  if (p.model) await selectModel(page, p.model);

  const timeoutMs = p.timeout || DEFAULT_TIMEOUT;
  const preNotes = [];
  const preNote = (m) => {
    preNotes.push(m);
    log(m);
  };
  if (queuedMs > 2000) {
    preNote(
      `waited ${Math.round(queuedMs / 1000)}s in the daemon queue — another agent was ` +
        'using the browser (one tab, so asks run one at a time)',
    );
  }

  // Don't clobber an answer that is still being generated (see waitUntilIdle).
  if (conv && !p.dom) {
    await waitUntilIdle(page, conv, Math.min(timeoutMs, 10 * 60 * 1000), preNote);
  }

  // Snapshot state BEFORE submitting so we only ever accept a NEW answer. This is
  // what makes follow-up turns safe: the previous answer is still on the page and
  // in the mapping, and without a baseline we would return it instantly.
  const apiBaseline = conv
    ? await softly(callApi(page, { op: 'baseline', convId: conv }), PAGE_OP_TIMEOUT, 'baseline', null)
    : null;
  const baseline = { ids: (apiBaseline && apiBaseline.ids) || [], maxTime: (apiBaseline && apiBaseline.maxTime) || 0 };
  const domBaseline = await getBaseline(page);

      await submitPrompt(page, prompt, p.images);
  // A new chat's URL becomes /c/<id> on its own schedule — sometimes only after
  // the answer has landed. Blocking on it cost 30s and, when it timed out, threw
  // away the API path for the whole turn (that is why a one-word answer took
  // 127s). So: glance for it, then let waitForAnswer pick it up whenever it
  // appears. Reading the URL is free, so this costs nothing.
  const convId0 = await resolveConversationId(page, conv, 5000);
  let res;
  if (!p.dom) {
    res = await waitForAnswer(page, {
      convId: convId0,
      baseline,
      timeoutMs,
      prompt,
      resubmit: () => submitPrompt(page, prompt, p.images),
      getPage: state.ensurePage,
    });
    if (res.apiBlocked) res = await captureResponseDom(page, timeoutMs, domBaseline);
  } else {
    log('using DOM extraction (--dom)');
    res = await captureResponseDom(page, timeoutMs, domBaseline);
  }

  // An empty answer plus a visible error banner means the turn really failed;
  // one retry usually succeeds (transient stream errors are common).
  if (!res.text || !res.text.trim()) {
    const banner = await detectErrorBanner(page);
    if (banner) {
      log('ChatGPT reported an error ("' + banner + '") — retrying once ...');
      await reloadPage(page);
  await submitPrompt(page, prompt, p.images);
      const retryId = await resolveConversationId(page, convId0, 30000);
      if (retryId) {
        const again = await waitForAnswer(page, {
          convId: retryId,
          baseline,
          timeoutMs,
          prompt,
          resubmit: null,
          getPage: state.ensurePage,
        });
        if (!again.apiBlocked) res = again;
      }
    }
  }

  // Pick up a page swapped in by a relaunch during the wait.
  if (page.isClosed() && state.page && !state.page.isClosed()) {
    page = state.page;
    log('continuing on the relaunched page');
  }

  let convId = (await getConversationId(page)) || convId0;
  let title = null;
  if (p.rename !== false) {
    const info = await ensureAgentTitle(page, { prompt, explicitTitle: p.title, isNew });
    convId = info.id || convId;
    title = info.title;
  } else if (convId) {
    title = await fetchConversationTitle(page, convId);
  }
  if (convId) state.currentConv = convId;
  return {
    answer: cleanAnswer(res.text),
    conversationId: convId,
    title,
    elapsed: res.elapsed,
    truncated: res.truncated,
    partial: !!res.partial,
    via: res.via || 'dom',
    apiCalls: res.apiCalls,
    notes: [...preNotes, ...(res.notes || [])],
    html: p.html ? res.html : undefined,
  };
}

async function cmdDaemon(opts) {
  let { ctx, page: initialPage } = await launch(opts.headless, opts.chromium);
  const state = { currentConv: null, page: initialPage };
  // Set when we close the browser on purpose, so the close handler can tell an
  // intentional shutdown apart from Chrome dying underneath us.
  let stopping = false;
  let relaunches = 0;
  let relaunching = null;
  const MAX_RELAUNCHES = 5;

  /**
   * Bring the browser back after it dies (crash, OOM kill, someone closing the
   * window). Exiting instead would strand every later ask with "fetch failed"
   * until something noticed and restarted us, and would throw away the queue.
   */
  async function relaunchBrowser(why) {
    if (stopping) return false;
    if (relaunches >= MAX_RELAUNCHES) {
      log(`browser died ${relaunches}x (${why}) — giving up so a fresh daemon can start`);
      clearDaemonState();
      process.exit(1);
    }
    if (relaunching) return relaunching; // collapse concurrent attempts into one
    relaunches++;
    log(`browser is gone (${why}) — relaunching (${relaunches}/${MAX_RELAUNCHES}) ...`);
    relaunching = (async () => {
      // A killed Chrome needs a moment to reap its children and release the
      // profile directory; launching into that window fails, so retry briefly.
      for (let attempt = 1; attempt <= 3; attempt++) {
        await sleep(attempt * 1500);
        try {
          const fresh = await launch(opts.headless, opts.chromium);
          ctx = fresh.ctx;
          state.page = fresh.page;
          attachCloseHandler();
          await softly(
            state.page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }),
            65000,
            'relaunch goto',
          );
          log('browser relaunched');
          return true;
        } catch (e) {
          log(`relaunch attempt ${attempt}/3 failed: ${String(e.message).split('\n')[0]}`);
        }
      }
      log('could not relaunch the browser — exiting so the next ask starts a clean daemon');
      clearDaemonState();
      process.exit(1);
    })().finally(() => {
      relaunching = null;
    });
    return relaunching;
  }

  function attachCloseHandler() {
    ctx.on('close', () => {
      if (stopping) return; // we asked for this
      // Don't exit: an ask may be mid-flight, and ChatGPT keeps generating
      // server-side regardless, so the answer is still retrievable after a
      // relaunch. Fire and forget — the handler cannot be async.
      relaunchBrowser('context closed').catch(() => {});
    });
  }

  /**
   * Hand back a usable page, reopening it if the tab crashed or was closed.
   * A renderer crash would otherwise poison every later request.
   */
  async function ensurePage() {
    if (state.page && !state.page.isClosed()) return state.page;
    log('page is gone (crash or manual close) — opening a fresh one');
    try {
      state.page = await ctx.newPage();
    } catch (e) {
      // newPage throws when the whole browser is gone, not just the tab.
      await relaunchBrowser('newPage failed: ' + e.message);
      return state.page;
    }
    await softly(
      state.page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }),
      65000,
      'recovery goto',
    );
    await sleep(1500);
    return state.page;
  }

  attachCloseHandler();
  // doAsk hands this to waitForAnswer so a mid-answer browser death is survivable.
  state.ensurePage = ensurePage;

  let loggedIn = false;
  try {
    await withTimeout(
      initialPage.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }),
      65000,
      'startup goto',
    );
    await sleep(2500);
    loggedIn = await isAuthed(ctx);
    if (loggedIn) log('daemon ready — logged in');
    else log('daemon ready — WARNING: not logged in (run: stop && sync && start)');
  } catch (e) {
    log('daemon startup error:', e.message);
  }

  // Serialize page operations so concurrent requests don't interleave: there is
  // one browser tab and one composer, so two agents typing at once would merge
  // their prompts. Waiting is therefore correct — but it must be VISIBLE, because
  // a 15-minute research run parks everyone else behind it, and a caller that
  // can't tell "queued" from "hung" will retry and make it worse.
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    state.queueDepth = (state.queueDepth || 0) + 1;
    const queuedAt = Date.now();
    const run = chain.then(
      () => fn(Date.now() - queuedAt),
      () => fn(Date.now() - queuedAt),
    );
    chain = run.catch(() => {});
    return run.finally(() => {
      state.queueDepth = Math.max(0, (state.queueDepth || 1) - 1);
    });
  };

  async function shutdown() {
    stopping = true;
    log('shutting down on request');
    try {
      server.close();
    } catch {
      /* ignore */
    }
    await ctx.close().catch(() => {});
    clearDaemonState();
    process.exit(0);
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      try {
        const params = body ? JSON.parse(body) : {};
        if (req.url === '/health') {
          // Re-check auth live: cookies expire while the daemon is running, so a
          // boolean captured at startup goes stale and misreports.
          const live = await softly(isAuthed(ctx), 8000, 'isAuthed', loggedIn);
          loggedIn = live === null ? loggedIn : live;
          const url = state.page && !state.page.isClosed() ? state.page.url() : '(no page)';
          return send({
            ok: true,
            loggedIn,
            currentConv: state.currentConv,
            url,
            queueDepth: state.queueDepth || 0,
          });
        }
        if (req.url === '/ask') {
          // Outer cap so the HTTP request always gets an answer, even if a page
          // op wedges in a way that the inner ladder doesn't cover. The timer starts
          // when this ask actually begins, not when it was queued, so queueing
          // behind another agent never eats into its own answer time.
          const cap = (params.timeout || DEFAULT_TIMEOUT) + 120000;
          // Stream headers immediately, then heartbeat with whitespace. Deep-research
          // answers routinely take 8+ minutes, and the CLI's fetch (undici) drops a
          // silent connection at its default headersTimeout (~300s) -> "fetch failed".
          // JSON.parse tolerates leading whitespace, so the client still parses fine.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          try { res.write(' '); } catch {}
          const hb = setInterval(() => { try { res.write(' '); } catch {} }, 20000);
          try {
            const result = await enqueue((queuedMs) =>
              withTimeout(ensurePage().then((pg) => doAsk(pg, state, params, queuedMs)), cap, 'ask'),
            );
            clearInterval(hb);
            try { res.end(JSON.stringify({ ok: true, ...result })); } catch {}
          } catch (e) {
            clearInterval(hb);
            try { res.end(JSON.stringify({ ok: false, error: e.message })); } catch {}
          }
          return;
        }
        if (req.url === '/list') {
          const items = await enqueue(() =>
            ensurePage().then((pg) => listConversations(pg, params.limit || 20)),
          );
          const filtered = params.agentOnly
            ? items.filter((it) => /^\[AGENT\]/i.test(it.title))
            : items;
          return send({ ok: true, items: filtered });
        }
        if (req.url === '/reset') {
          await enqueue(async () => {
            state.currentConv = null;
          });
          return send({ ok: true });
        }
        if (req.url === '/stop') {
          send({ ok: true });
          setTimeout(shutdown, 100);
          return;
        }
        send({ ok: false, error: 'unknown endpoint ' + req.url }, 404);
      } catch (e) {
        send({ ok: false, error: e.message }, 500);
      }
    });
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Long-running /ask responses must survive idle-timeout reaping (server side),
  // and TCP keepalive probes keep any middlebox conntrack entries fresh.
  server.requestTimeout = 0;
  server.keepAliveTimeout = 0;
  server.on('connection', (sock) => {
    try { sock.setKeepAlive(true, 15000); } catch {}
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  writeDaemonState(port, process.pid);
  log('daemon listening on 127.0.0.1:' + port + ' (pid ' + process.pid + ')');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const cmd = opts._.shift();

  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  if (!cmd) {
    printHelp();
    process.exit(1);
  }

  try {
    switch (cmd) {
      case 'login':
        await cmdLogin(opts);
        break;
      case 'sync':
        await cmdSync(opts);
        break;
      case 'status':
        await cmdStatus(opts);
        break;
      case 'start':
        await cmdStart(opts);
        break;
      case 'stop':
        await cmdStop(opts);
        break;
      case 'daemon':
        await cmdDaemon(opts);
        break;
      case 'list':
      case 'ls':
        await cmdList(opts);
        break;
      case 'sessions':
        await cmdSessions(opts);
        break;
      case 'chat':
        await cmdChat(opts);
        break;
      case 'ask': {
        let prompt = opts._.join(' ').trim();
        if (!prompt && !process.stdin.isTTY) {
          prompt = fs.readFileSync(0, 'utf8').trim();
        }
        await cmdAsk(prompt, opts);
        break;
      }
      default:
        console.error('Unknown command: ' + cmd);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error('[ask-chatgpt] ERROR:', err.message);
    process.exit(1);
  }
}

main();
