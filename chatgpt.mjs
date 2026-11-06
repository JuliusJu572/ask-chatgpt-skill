#!/usr/bin/env node
/**
 * ask-chatgpt v2 — ask the ChatGPT WEB app from the terminal.
 *
 * Design (rewritten 2026-10 after ChatGPT's UI overhaul broke v1):
 *
 *   Browser   A normal Chromium/Chrome process runs detached with a dedicated
 *             profile and a CDP port. Every CLI call attaches over CDP, does its
 *             work and detaches; the browser (and login) stays warm. No node
 *             daemon, no RPC heartbeats.
 *   Lock      One ask at a time (one login, one composer). A pid-stamped lock
 *             directory serializes callers; a dead owner's lock is reclaimed.
 *   SEND      Typed into the composer, submitted with Enter, and CONFIRMED by
 *             observing the POST /backend-api/(f/)conversation request. If no
 *             request appears, the send button is clicked as a fallback.
 *   WAIT      That request is an SSE stream: when it finishes, the turn is over
 *             (or handed to the server). Zero polling while it streams.
 *   READ      GET /backend-api/conversation/<id> (inside the page, with the
 *             page's own session). The answer is located by walking current_node
 *             back to OUR user message — never by CSS classes. If the server is
 *             still working after the stream closed, poll with backoff.
 *
 * Only the composer (div.ProseMirror) and a few aria-labels touch the UI, so the
 * tool keeps working across UI languages and layout changes.
 *
 * stdout = the answer only.  stderr = progress.  exit 0 ok / 1 error / 3 incomplete.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// ASK_CHATGPT_STATE_DIR + ASK_CHATGPT_PROFILE let callers run isolated instances
// (own browser, lock, sessions) side by side — e.g. stock-analysis/parallel_research.py.
const STATE_DIR = process.env.ASK_CHATGPT_STATE_DIR || path.join(os.homedir(), '.ask-chatgpt');
const PROFILE_DIR = process.env.ASK_CHATGPT_PROFILE || path.join(STATE_DIR, 'profile');
const BROWSER_LOG = path.join(STATE_DIR, 'browser.log');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const LAST_FILE = path.join(STATE_DIR, 'last.json');
const LOCK_DIR = path.join(STATE_DIR, 'ask.lock');
const LEGACY_DAEMON = path.join(STATE_DIR, 'daemon.json');
const DEBUG_DIR = path.join(STATE_DIR, 'debug');

const ORIGIN = 'https://chatgpt.com';
const envInt = (name, dflt) => {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
// Deep research / heavy thinking runs 5-15 minutes; 15 min is the default.
const DEFAULT_TIMEOUT = envInt('ASK_CHATGPT_TIMEOUT_MS', 15 * 60 * 1000);
const LOCK_WAIT_MS = envInt('ASK_CHATGPT_LOCK_WAIT_MS', 20 * 60 * 1000);
const EXIT_INCOMPLETE = 3;
const AGENT_PREFIX = '[AGENT] ';

const RE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// The POST that carries a new turn. v1 watched /backend-api/conversation; the web
// app now uses /backend-api/f/conversation. Match both, but not /init, /prepare.
const RE_SEND_URL = /\/backend-(?:api|anon)\/(?:f\/)?conversation\/?(?:\?|$)/;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => {
  const t = new Date().toTimeString().slice(0, 8);
  console.error(`[ask-chatgpt ${t}]`, ...args);
};

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function pidCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return null; // not Linux, or gone
  }
}

function readJson(file, dflt) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return dflt;
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Letters/digits only — for "is the composer holding our prompt?" checks. */
const normText = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// ChatGPT wraps citation widgets in private-use delimiters (U+E200 .. U+E201).
const PUA_OPEN = String.fromCharCode(0xe200);
const PUA_CLOSE = String.fromCharCode(0xe201);
const RE_CITE_BLOCK = new RegExp(PUA_OPEN + '[\\s\\S]*?' + PUA_CLOSE, 'g');
const RE_PUA_STRAY = new RegExp(`[${String.fromCharCode(0xe200)}-${String.fromCharCode(0xe20f)}]`, 'g');

function cleanAnswer(text) {
  return (text || '')
    .replace(RE_CITE_BLOCK, '')
    .replace(/\bcite(?:turn\w*)+/g, '')
    .replace(RE_PUA_STRAY, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function convIdFromUrl(url) {
  const m = /\/c\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(url || '');
  return m && RE_UUID.test(m[1]) ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    _: [], timeout: DEFAULT_TIMEOUT, model: null, newChat: false, continueLast: false,
    save: null, conv: null, title: null, noRename: false, limit: 20, json: false,
    agentOnly: false, session: null, images: [], headless: false, wait: false, help: false,
  };
  const need = (i, flag) => {
    if (i >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--timeout': o.timeout = parseInt(need(++i, a), 10) || DEFAULT_TIMEOUT; break;
      case '--model': case '-m': o.model = need(++i, a); break;
      case '--new': o.newChat = true; break;
      case '--no-new': o.continueLast = true; break;
      case '--save': o.save = need(++i, a); break;
      case '--conv': case '--continue': o.conv = need(++i, a); break;
      case '--title': o.title = need(++i, a); break;
      case '--no-rename': o.noRename = true; break;
      case '--limit': o.limit = parseInt(need(++i, a), 10) || 20; break;
      case '--json': o.json = true; break;
      case '--agent-only': o.agentOnly = true; break;
      case '--session': case '-s': o.session = need(++i, a); break;
      case '--image': case '-i': o.images.push(need(++i, a)); break;
      case '--headless': o.headless = true; break;
      case '--wait': o.wait = true; break;
      // v1 flags kept as no-ops so existing callers don't break.
      case '--dom': case '--html': case '--chromium': break;
      case '-h': case '--help': o.help = true; break;
      default: o._.push(a);
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// Ask lock — one ask at a time across every terminal / agent.
//
// mkdir is atomic; the owner (pid + start time) is written inside. A lock whose
// owner process is gone is reclaimed, so a SIGKILLed caller can never wedge the
// tool. The steal is a rename (atomic) so two reclaimers cannot both "win".
// ---------------------------------------------------------------------------

const LOCK_OWNER = path.join(LOCK_DIR, 'owner.json');

function lockOwner() {
  return readJson(LOCK_OWNER, null);
}

function ownerAlive(owner) {
  if (!owner || !isPidAlive(owner.pid)) return false;
  const cmd = pidCmdline(owner.pid);
  return cmd === null || cmd.includes('chatgpt.mjs'); // guard against pid reuse
}

function releaseLock() {
  const o = lockOwner();
  if (o && o.pid === process.pid) {
    try {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function acquireLock(what) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const start = Date.now();
  let lastNote = 0;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(LOCK_OWNER, JSON.stringify({ pid: process.pid, since: Date.now(), what }));
      process.once('exit', releaseLock);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const owner = lockOwner();
    let stale = false;
    if (owner) stale = !ownerAlive(owner);
    else {
      // Owner file not written yet (a racer between mkdir and write) or junk.
      try {
        stale = Date.now() - fs.statSync(LOCK_DIR).mtimeMs > 10000;
      } catch {
        continue; // vanished — retry immediately
      }
    }
    if (stale) {
      const tomb = `${LOCK_DIR}.stale.${process.pid}.${Date.now()}`;
      try {
        fs.renameSync(LOCK_DIR, tomb);
        const got = readJson(path.join(tomb, 'owner.json'), null);
        if (got && owner && got.pid !== owner.pid && ownerAlive(got)) {
          // Raced: we grabbed a fresh lock somebody just took. Give it back.
          fs.renameSync(tomb, LOCK_DIR);
        } else {
          fs.rmSync(tomb, { recursive: true, force: true });
          log('reclaimed a stale lock left by a dead process' + (owner ? ` (pid ${owner.pid})` : ''));
        }
      } catch {
        /* someone else handled it */
      }
      continue;
    }
    const waited = Date.now() - start;
    if (waited > LOCK_WAIT_MS) {
      throw new Error(
        `another ask (pid ${owner && owner.pid}) has held the browser for ` +
          `${Math.round((Date.now() - ((owner && owner.since) || start)) / 1000)}s — gave up waiting. ` +
          'Asks share one ChatGPT login and must run one at a time.',
      );
    }
    if (Date.now() - lastNote > 30000) {
      lastNote = Date.now();
      const busyFor = owner && owner.since ? Math.round((Date.now() - owner.since) / 1000) : '?';
      log(`waiting for another ask to finish (pid ${owner && owner.pid}, running ${busyFor}s) — asks are serialized`);
    }
    await sleep(1000);
  }
}

// ---------------------------------------------------------------------------
// Named sessions (same file format as v1, so old sessions keep working)
// ---------------------------------------------------------------------------

function readSessions() {
  const j = readJson(SESSIONS_FILE, {});
  return j && typeof j === 'object' ? j : {};
}

function getSessionConv(name) {
  if (!name) return null;
  const s = readSessions()[name];
  return (s && s.conversationId) || null;
}

function saveSession(name, conversationId, title) {
  if (!name || !conversationId) return;
  const all = readSessions(); // re-read right before writing
  const prev = all[name] || {};
  all[name] = {
    conversationId,
    title: title || (prev.conversationId === conversationId ? prev.title : '') || '',
    updated: new Date().toISOString(),
  };
  writeJsonAtomic(SESSIONS_FILE, all);
}

function saveLast(conversationId) {
  if (conversationId) writeJsonAtomic(LAST_FILE, { conversationId, updated: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Browser lifecycle: a detached browser with a CDP port; we attach per call.
// ---------------------------------------------------------------------------

// Kept inside the profile so copies of the profile inherit the browser choice.
const BROWSER_STATE = path.join(PROFILE_DIR, 'ask-chatgpt-browser.json');
const OLD_BROWSER_STATE = path.join(STATE_DIR, 'browser.json');

function devtoolsPort() {
  try {
    const port = parseInt(fs.readFileSync(path.join(PROFILE_DIR, 'DevToolsActivePort'), 'utf8').split('\n')[0], 10);
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

async function cdpAlive(port) {
  if (!port) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

function profileLockPid() {
  try {
    const m = /-(\d+)$/.exec(fs.readlinkSync(path.join(PROFILE_DIR, 'SingletonLock')));
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

/**
 * Pick the browser binary. Sticky: cookies are encrypted with a per-binary
 * keyring entry (Chrome vs Chromium), so switching binaries on the same profile
 * silently logs you out. Once a binary has been used, keep using it.
 */
function pickBrowserExe() {
  if (process.env.ASK_CHATGPT_BROWSER) return process.env.ASK_CHATGPT_BROWSER;
  const prev = readJson(BROWSER_STATE, null)?.exe || readJson(OLD_BROWSER_STATE, {}).exe;
  if (prev && fs.existsSync(prev)) return prev;
  const system = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((p) => fs.existsSync(p));
  if (process.env.ASK_CHATGPT_CHANNEL === 'chromium' || !system) return chromium.executablePath();
  return system;
}

async function killPid(pid, label) {
  if (!isPidAlive(pid)) return;
  log(`stopping ${label} (pid ${pid})`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 25 && isPidAlive(pid); i++) await sleep(200);
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
    await sleep(500);
  }
}

/** v1 ran a node daemon that owned the profile. Shut it down if it is still around. */
async function stopLegacyDaemon() {
  const s = readJson(LEGACY_DAEMON, null);
  if (!s) return;
  if (s.port) {
    try {
      await fetch(`http://127.0.0.1:${s.port}/stop`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(3000) });
    } catch {
      /* gone */
    }
  }
  await sleep(1500);
  if (s.pid && isPidAlive(s.pid) && (pidCmdline(s.pid) || '').includes('chatgpt.mjs')) await killPid(s.pid, 'old v1 daemon');
  try {
    fs.unlinkSync(LEGACY_DAEMON);
  } catch {
    /* ignore */
  }
}

/** Free the profile from a browser that holds it but has no working CDP port. */
async function freeProfile() {
  const pid = profileLockPid();
  if (pid && isPidAlive(pid)) {
    const cmd = pidCmdline(pid);
    if (cmd === null || cmd.includes(PROFILE_DIR)) await killPid(pid, 'unreachable browser holding the profile');
    else log(`warning: profile lock points at pid ${pid}, which is not our browser — leaving it`);
  }
  if (!isPidAlive(profileLockPid())) {
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
      try {
        fs.rmSync(path.join(PROFILE_DIR, f), { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

async function launchBrowser({ headless = false } = {}) {
  await stopLegacyDaemon();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  await freeProfile();
  const exe = pickBrowserExe();
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    '--remote-debugging-port=0', // Chrome picks a free port and writes DevToolsActivePort
    '--remote-debugging-address=127.0.0.1',
    // Cookies copied from a real Chrome are encrypted with the desktop keyring key.
    '--password-store=gnome',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    // A background/occluded tab must keep streaming at full speed.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1280,900',
  ];
  if (headless) args.push('--headless=new');
  args.push(`${ORIGIN}/`);
  log(`starting browser: ${exe}${headless ? ' (headless)' : ''}`);
  const out = fs.openSync(BROWSER_LOG, 'a');
  const child = spawn(exe, args, { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  let died = null;
  child.once('exit', (code) => (died = code));
  for (let i = 0; i < 150; i++) {
    await sleep(200);
    if (died !== null) throw new Error(`browser exited immediately (code ${died}) — see ${BROWSER_LOG}`);
    const port = devtoolsPort();
    if (port && (await cdpAlive(port))) {
      writeJsonAtomic(BROWSER_STATE, { exe, pid: child.pid, headless, port, started: new Date().toISOString() });
      return port;
    }
  }
  throw new Error(`browser did not open its debugging port within 30s — see ${BROWSER_LOG}`);
}

async function connect({ headless = false, launch = true } = {}) {
  let port = devtoolsPort();
  if (!(await cdpAlive(port))) {
    if (!launch) return null;
    port = await launchBrowser({ headless });
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30000 });
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('browser has no default context');
  return { browser, ctx, port };
}

/** The tab we drive: an existing chatgpt.com tab if there is one, else a new tab. */
async function getChatPage(ctx) {
  const pages = ctx.pages().filter((p) => !p.isClosed());
  let page = pages.find((p) => p.url().startsWith(ORIGIN)) || pages.find((p) => /^(about:blank|chrome:\/\/newtab)/.test(p.url()));
  if (!page) page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {})); // e.g. "leave site?" on navigation
  return page;
}

async function saveDebug(page, tag) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const f = path.join(DEBUG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}.png`);
    await withTimeout(page.screenshot({ path: f }), 10000, 'screenshot');
    log(`debug screenshot: ${f}`);
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Backend API — runs INSIDE the page so it uses the page's own login session.
// ---------------------------------------------------------------------------

/** Executed in the page. Must be self-contained. */
async function pageFetch({ apiPath, method, body, timeoutMs }) {
  const w = window;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const getToken = async (force) => {
      if (!force && w.__acgTok && Date.now() - w.__acgTokAt < 5 * 60 * 1000) return w.__acgTok;
      const r = await fetch('/api/auth/session', { credentials: 'include', signal: ctrl.signal });
      const j = r.ok ? await r.json().catch(() => ({})) : {};
      w.__acgTok = j.accessToken || null;
      w.__acgTokAt = Date.now();
      return w.__acgTok;
    };
    const did = (document.cookie.match(/(?:^|;\s*)oai-did=([^;]+)/) || [])[1];
    const go = (tok) =>
      fetch(apiPath, {
        method: method || 'GET',
        credentials: 'include',
        signal: ctrl.signal,
        headers: {
          ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
          ...(did ? { 'oai-device-id': did } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    let tok = await getToken(false);
    if (!tok) return { ok: false, status: 401, error: 'no access token — not logged in?' };
    let r = await go(tok);
    if (r.status === 401 || r.status === 403) {
      tok = await getToken(true);
      if (tok) r = await go(tok);
    }
    const txt = await r.text();
    let json = null;
    try {
      json = JSON.parse(txt);
    } catch {
      /* HTML error page */
    }
    return { ok: r.ok, status: r.status, json, error: r.ok ? null : (txt || '').slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function api(page, apiPath, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTimeout(
        page.evaluate(pageFetch, { apiPath, method, body, timeoutMs }),
        timeoutMs + 5000,
        'api ' + apiPath,
      );
    } catch (e) {
      // "Execution context was destroyed" while the SPA navigates — retry.
      if (attempt < 2 && !page.isClosed()) {
        await sleep(1500);
        continue;
      }
      return { ok: false, status: 0, error: e.message };
    }
  }
}

async function getSessionInfo(page) {
  try {
    return await withTimeout(
      page.evaluate(async () => {
        try {
          const r = await fetch('/api/auth/session', { credentials: 'include' });
          const j = await r.json().catch(() => ({}));
          return { ok: r.ok, authed: !!j.accessToken, email: (j.user && j.user.email) || null };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }),
      20000,
      'session',
    );
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const readConversation = (page, id) => api(page, `/backend-api/conversation/${id}`, { timeoutMs: 45000 });

// ---------------------------------------------------------------------------
// Turn analysis — pure function over the conversation JSON.
//
// The visible thread is the chain current_node -> parent -> ... -> root. Our turn
// starts at the last visible USER message on that chain; the answer is the
// assistant text after it (channel "final" preferred). Reasoning ("thoughts"),
// tool calls (recipient != all) and hidden nodes are skipped.
// ---------------------------------------------------------------------------

function msgText(m) {
  const c = m && m.content;
  if (!c) return '';
  if (Array.isArray(c.parts)) {
    return c.parts
      .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .join('')
      .trim();
  }
  return typeof c.text === 'string' ? c.text.trim() : '';
}

function threadPath(conv) {
  const mapping = (conv && conv.mapping) || {};
  const out = [];
  let id = conv && conv.current_node;
  for (let guard = 0; id && mapping[id] && guard < 100000; guard++) {
    out.push(mapping[id]);
    id = mapping[id].parent;
  }
  return out.reverse().filter((n) => n && n.message);
}

const isHidden = (m) => !!(m.metadata && m.metadata.is_visually_hidden_from_conversation);

/**
 * -> { state, text, partial, promptMatch, userId, error, title }
 *    state: missing (our user message is not there yet) | generating | idle
 *           (nothing running, no end-of-turn) | done | done-empty | error
 */
function analyzeTurn(conv, { knownIds = null, prompt = null } = {}) {
  const nodes = threadPath(conv);
  const asyncBusy = conv.async_status !== null && conv.async_status !== undefined;
  let ui = -1;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const m = nodes[i].message;
    if (m.author && m.author.role === 'user' && !isHidden(m)) {
      ui = i;
      break;
    }
  }
  const base = { title: conv.title || '', asyncBusy };
  if (ui < 0 || (knownIds && knownIds.has(nodes[ui].id))) return { ...base, state: 'missing', text: '' };

  const user = nodes[ui].message;
  let promptMatch = true;
  if (prompt) {
    const a = normText(prompt).slice(0, 300);
    const b = normText(msgText(user));
    promptMatch = !a || !b || b.includes(a.slice(0, 120)) || a.includes(b.slice(0, 120));
  }
  const after = nodes.slice(ui + 1).map((n) => n.message);
  const isAnswer = (m) =>
    m.author &&
    m.author.role === 'assistant' &&
    (!m.recipient || m.recipient === 'all') &&
    m.content &&
    (m.content.content_type === 'text' || m.content.content_type === 'multimodal_text') &&
    !isHidden(m) &&
    m.channel !== 'analysis' &&
    m.channel !== 'commentary' &&
    msgText(m);
  const answers = after.filter(isAnswer);
  const finals = answers.filter((m) => m.channel === 'final');
  const answer = (finals.length ? finals : answers).at(-1) || null;
  const text = answer ? msgText(answer) : '';
  const inProgress = after.some((m) => m.status === 'in_progress');
  // end_turn=true marks the end of the turn; trailing bookkeeping nodes (e.g. a
  // reasoning_recap summary) may follow it, so it need not be the last node.
  const ended =
    !inProgress &&
    (after.some((m) => m.author && m.author.role === 'assistant' && m.end_turn === true) ||
      (answer && answer.channel === 'final' && answer.status === 'finished_successfully'));
  const sysErr = after.find((m) => m.content && m.content.content_type === 'system_error');

  let state;
  if (ended && !asyncBusy) state = text ? 'done' : sysErr ? 'error' : 'done-empty';
  else if (inProgress || asyncBusy) state = 'generating';
  else if (sysErr && !text) state = 'error';
  else state = 'idle';
  return {
    ...base,
    state,
    text,
    partial: !!answer && answer.status === 'finished_partial_completion',
    promptMatch,
    userId: nodes[ui].id,
    error: sysErr ? msgText(sysErr) || 'ChatGPT returned an error' : null,
  };
}

// ---------------------------------------------------------------------------
// Page readiness
// ---------------------------------------------------------------------------

const COMPOSER_CANDIDATES =
  'div.ProseMirror[contenteditable="true"], #prompt-textarea[contenteditable="true"], textarea#prompt-textarea';
const COMPOSER = '[data-acg-composer="1"]';

/** Inspect the page and tag the real composer (not the floating quick-chat one). */
async function pageState(page) {
  try {
    return await withTimeout(
      page.evaluate((sel) => {
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        document.querySelectorAll('[data-acg-composer]').forEach((e) => e.removeAttribute('data-acg-composer'));
        const all = [...document.querySelectorAll(sel)].filter(vis);
        const main = all.filter((e) => !e.closest('[data-floating-chat-surface], [role="dialog"]'));
        const ed = main[0] || null;
        if (ed) ed.setAttribute('data-acg-composer', '1');
        const title = document.title || '';
        const cloudflare =
          /just a moment|checking your browser|请稍候|稍等/i.test(title) ||
          !!document.querySelector('#challenge-running, #challenge-form, .cf-browser-verification');
        const btnText = [...document.querySelectorAll('button')].filter(vis).map((b) => (b.innerText || '').trim());
        const errorPage = !ed && btnText.some((t) => /^(reload|try again|重新加载|重试)$/i.test(t));
        const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"]')].some(
          (d) => vis(d) && !d.querySelector(sel) && !d.closest('[data-floating-chat-surface]'),
        );
        return { composer: !!ed, cloudflare, errorPage, modal, title };
      }, COMPOSER_CANDIDATES),
      15000,
      'pageState',
    );
  } catch {
    return { composer: false, cloudflare: false, errorPage: false, modal: false, title: '' };
  }
}

async function gotoRetry(page, url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      return;
    } catch (e) {
      lastErr = e;
      log(`navigation to ${url} failed (attempt ${attempt}/3): ${String(e.message).split('\n')[0]}`);
      await sleep(2000 * attempt);
    }
  }
  throw new Error(`could not open ${url}: ${String(lastErr && lastErr.message).split('\n')[0]}`);
}

/** Navigate and wait until the composer is usable and the account is logged in. */
async function openChat(page, url) {
  await gotoRetry(page, url);
  const start = Date.now();
  let reloads = 0;
  let lastEsc = 0;
  for (;;) {
    const st = await pageState(page);
    if (st.composer && !st.modal) break;
    const waited = Date.now() - start;
    if (st.errorPage && reloads < 2) {
      reloads++;
      log(`ChatGPT showed an error page — reloading (${reloads}/2)`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(2000);
      continue;
    }
    if (st.modal && Date.now() - lastEsc > 2000) {
      lastEsc = Date.now();
      await page.keyboard.press('Escape').catch(() => {});
    }
    if (waited > 60000 || (st.cloudflare && waited > 45000)) {
      await saveDebug(page, 'not-ready');
      if (st.cloudflare) {
        const e = new Error('Cloudflare is blocking the browser (do not use --headless; run "stop" then retry)');
        e.code = 'CLOUDFLARE';
        throw e;
      }
      const s = await getSessionInfo(page);
      if (s.ok && !s.authed) throw notLoggedIn();
      throw new Error(`ChatGPT page never became ready (title "${st.title}") — screenshot saved`);
    }
    await sleep(500);
  }
  const s = await getSessionInfo(page);
  if (s.ok && !s.authed) throw notLoggedIn();
}

function notLoggedIn() {
  const e = new Error('NOT_LOGGED_IN — run: node chatgpt.mjs login   (or: node chatgpt.mjs sync)');
  e.code = 'NOT_LOGGED_IN';
  return e;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

async function composerText(page) {
  await pageState(page); // re-tag: the composer may have re-rendered
  return page.locator(COMPOSER).first().evaluate((el) => el.innerText || el.value || '').catch(() => '');
}

async function focusComposer(page) {
  await pageState(page);
  const c = page.locator(COMPOSER).first();
  await c.click({ timeout: 10000 }).catch(async () => {
    await c.evaluate((el) => el.focus()).catch(() => {});
  });
}

/** Empty the composer: leftover drafts persist across reloads and would be sent with our prompt. */
async function clearComposer(page) {
  for (let i = 0; i < 3; i++) {
    // Remove stale attachments inside the composer box (buttons like "remove file").
    await page
      .evaluate((sel) => {
        const ed = document.querySelector(sel);
        if (!ed) return;
        let box = ed;
        for (let k = 0; k < 8 && box.parentElement; k++) {
          box = box.parentElement;
          if (box.tagName === 'FORM' || box.querySelector('button[aria-label*="发送"], button[aria-label*="Send" i], button[data-testid="send-button"]')) break;
        }
        for (const b of box.querySelectorAll('button[aria-label]')) {
          if (/remove|delete|移除|删除/i.test(b.getAttribute('aria-label') || '')) b.click();
        }
      }, COMPOSER)
      .catch(() => {});
    await focusComposer(page);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await sleep(200);
    if (!normText(await composerText(page))) return;
  }
  log('warning: could not fully clear the composer');
}

async function fillComposer(page, prompt) {
  await focusComposer(page);
  await page.keyboard.insertText(prompt);
  await sleep(300);
  const want = normText(prompt);
  let got = normText(await composerText(page));
  if (got.length >= want.length * 0.9) return;
  // Fallback: a synthetic paste, which ProseMirror handles natively.
  log('typing did not land fully — retrying with paste');
  await clearComposer(page);
  await page
    .locator(COMPOSER)
    .first()
    .evaluate((el, text) => {
      el.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, prompt);
  await sleep(500);
  got = normText(await composerText(page));
  // Very long pastes may become a "pasted text" attachment — acceptable.
  if (got.length < want.length * 0.9 && got.length > 0) {
    throw new Error(`prompt did not fit into the composer (${got.length}/${want.length} chars landed)`);
  }
}

/**
 * Attach files and wait until ChatGPT has processed every upload.
 * Proof of attachment is the POST /backend-api/files it triggers; if an input
 * swallows the files (not hydrated yet, wrong input), try the next candidate.
 */
async function uploadFiles(page, files) {
  const allImages = files.every((f) => /\.(png|jpe?g|gif|webp|bmp|heic|avif)$/i.test(f));
  let posted = 0;
  let processed = 0;
  let failed = 0;
  const onReq = (r) => r.method() === 'POST' && /\/backend-api\/files\/?(\?|$)/.test(new URL(r.url()).pathname + '?') && posted++;
  const onDone = (r) => /\/backend-api\/files\/process_upload_stream/.test(r.url()) && processed++;
  const onFail = (r) => /\/backend-api\/files/.test(r.url()) && failed++;
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onFail);
  try {
    log(`uploading ${files.length} file(s) ...`);
    for (let round = 0; round < 2 && !posted; round++) {
      if (round) {
        log('upload did not start — retrying');
        await sleep(2000);
        await pageState(page);
      }
      const n = await page.evaluate((imagesOnly) => {
        const ins = [...document.querySelectorAll('input[type="file"]')].filter((i) => !i.closest('[data-floating-chat-surface]'));
        const score = (i) =>
          (i.multiple ? 2 : 0) +
          (imagesOnly ? (/^image\/\*$/.test(i.accept) ? 3 : /image/.test(i.accept) ? 1 : 0) : i.accept === '' ? 3 : 0);
        ins.sort((a, b) => score(b) - score(a));
        document.querySelectorAll('[data-acg-file]').forEach((e) => e.removeAttribute('data-acg-file'));
        ins.forEach((e, k) => e.setAttribute('data-acg-file', String(k)));
        return ins.map((e) => e.multiple);
      }, allImages);
      if (!n.length) throw new Error('no file-upload input found on the page');
      for (let k = 0; k < n.length && !posted; k++) {
        const loc = page.locator(`[data-acg-file="${k}"]`);
        const batches = n[k] ? [files] : files.map((f) => [f]);
        for (const b of batches) await loc.setInputFiles(b).catch((e) => log(`input ${k}: ${e.message.split('\n')[0]}`));
        const until = Date.now() + 5000;
        while (!posted && Date.now() < until) await sleep(150);
      }
    }
    if (!posted) {
      await saveDebug(page, 'upload-failed');
      throw new Error('could not attach the file(s) — the upload never started (screenshot saved)');
    }
    const start = Date.now();
    while (processed < files.length && Date.now() - start < 120000) {
      if (failed) throw new Error('file upload failed (network)');
      await sleep(300);
    }
    if (processed < files.length) log(`warning: only ${processed}/${files.length} upload(s) confirmed — sending anyway`);
    await sleep(500);
  } finally {
    page.off('request', onReq);
    page.off('requestfinished', onDone);
    page.off('requestfailed', onFail);
  }
}

// ---------------------------------------------------------------------------
// Send + track the SSE request that carries the turn
// ---------------------------------------------------------------------------

/**
 * Watches everything that carries the turn:
 *   - the POST /backend-api/f/conversation SSE request (proves the prompt was sent;
 *     the web app aborts it once the chat gets its real /c/<id> URL)
 *   - the ws.chatgpt.com WebSocket, which then carries the stream and finally
 *     pushes {type:"conversation-turn-complete", conversation_id} — the
 *     authoritative, free "this turn is over" signal.
 * Create it BEFORE navigating (so the page's WebSocket is captured) and arm() it
 * right before pressing Enter (so earlier turns can't be mistaken for ours).
 */
function trackSend(page, knownConv) {
  const t = {
    armed: false, req: null, started: null, status: null, sseDone: false, failed: null,
    convId: knownConv || null, body: '', wsActive: false, wsLast: 0, turnDone: false,
  };
  const onReq = (req) => {
    if (!t.armed || t.req || req.method() !== 'POST' || !RE_SEND_URL.test(new URL(req.url()).pathname + '?')) return;
    t.req = req;
    t.started = Date.now();
    try {
      const j = req.postDataJSON();
      if (!t.convId && j && typeof j.conversation_id === 'string' && RE_UUID.test(j.conversation_id)) t.convId = j.conversation_id;
    } catch {
      /* not JSON */
    }
  };
  const onResp = (res) => {
    if (res.request() === t.req) t.status = res.status();
  };
  const onFinished = async (req) => {
    if (req !== t.req) return;
    try {
      const res = await req.response();
      t.body = res ? (await res.text().catch(() => '')).slice(-200000) : '';
      const m = /"conversation_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(t.body);
      if (m && !t.convId) t.convId = m[1];
    } catch {
      /* body unavailable */
    }
    t.sseDone = true;
  };
  const onFailed = (req) => {
    if (req === t.req) t.failed = (req.failure() && req.failure().errorText) || 'request failed';
  };
  const onFrame = (f) => {
    if (!t.armed || !t.req) return;
    let msgs;
    try {
      msgs = [].concat(JSON.parse(String(f.payload)));
    } catch {
      return;
    }
    for (const m of msgs) {
      const p = m && m.type === 'message' && m.payload;
      if (!p) continue;
      const inner = p.payload || {};
      const cid = inner.conversation_id;
      const ours = !t.convId || !cid || cid === t.convId;
      if (p.type === 'conversation-turn-stream' && ours) {
        t.wsActive = true;
        t.wsLast = Date.now();
        if (cid && !t.convId) t.convId = cid;
        if (inner.type === 'done' && t.wsActive) t.turnDone = true;
      } else if (p.type === 'conversation-turn-complete' && ours && t.wsActive) {
        if (cid && !t.convId) t.convId = cid;
        t.turnDone = true;
      }
    }
  };
  const onWs = (ws) => ws.on('framereceived', onFrame);
  page.on('websocket', onWs);
  page.on('request', onReq);
  page.on('response', onResp);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  t.arm = () => (t.armed = true);
  t.dispose = () => {
    page.off('websocket', onWs);
    page.off('request', onReq);
    page.off('response', onResp);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
  };
  t.waitStarted = async (ms) => {
    const end = Date.now() + ms;
    while (!t.req && Date.now() < end) await sleep(100);
    return !!t.req;
  };
  return t;
}

async function clickSend(page) {
  return page
    .evaluate(() => {
      const vis = (el) => el.getBoundingClientRect().width > 0;
      const b = [...document.querySelectorAll('button')].find(
        (x) =>
          vis(x) &&
          !x.disabled &&
          x.getAttribute('aria-disabled') !== 'true' &&
          (/^(send|send prompt|send message|发送|傳送)$/i.test((x.getAttribute('aria-label') || '').trim()) ||
            x.dataset.testid === 'send-button' ||
            x.id === 'composer-submit-button'),
      );
      if (b) b.click();
      return !!b;
    })
    .catch(() => false);
}

async function sendPrompt(page, tracker) {
  await focusComposer(page);
  await page.keyboard.press('Enter');
  if (await tracker.waitStarted(4000)) return;
  log('Enter did not send — clicking the send button');
  await clickSend(page);
  if (await tracker.waitStarted(8000)) return;
  await saveDebug(page, 'send-failed');
  throw new Error('the prompt was never sent (no conversation request seen) — screenshot saved');
}

// ---------------------------------------------------------------------------
// Wait for the answer
// ---------------------------------------------------------------------------

async function domAnswer(page) {
  return page
    .evaluate(() => {
      const sels = [
        '[data-local-conversation-final-assistant] [data-markdown-text-style="assistant-message"]',
        '[data-markdown-text-style="assistant-message"]',
        '[data-message-author-role="assistant"] .markdown',
        '.markdown',
      ];
      for (const s of sels) {
        const els = document.querySelectorAll(s);
        if (els.length) return (els[els.length - 1].innerText || '').trim();
      }
      return '';
    })
    .catch(() => '');
}

function sseError(body) {
  if (!body) return null;
  const m =
    /"error"\s*:\s*"([^"]{3,300})"/.exec(body) ||
    /"detail"\s*:\s*"([^"]{3,300})"/.exec(body) ||
    /"detail"\s*:\s*\{[^}]*"message"\s*:\s*"([^"]{3,300})"/.exec(body);
  return m ? m[1] : null;
}

/**
 * Phase A: the SSE stream is open -> do nothing but watch (0 API calls).
 * Phase B: it closed -> read the conversation once.
 * Phase C: server still working (deep research, dropped stream) -> poll with backoff.
 */
async function waitForAnswer(page, { tracker, conv, knownIds, prompt, deadline, onConv }) {
  const t0 = tracker.started || Date.now();
  const secs = () => Math.round((Date.now() - t0) / 1000);
  let convId = conv || null;
  const adopt = (id) => {
    if (id && !convId) {
      convId = id;
      onConv && onConv(id);
    }
  };
  let crashed = false;
  page.once('crash', () => (crashed = true));

  // ---- Phase A: free waiting on the live stream ----
  let lastProgress = Date.now();
  let why = 'deadline';
  while (Date.now() < deadline && !crashed && !page.isClosed()) {
    adopt(tracker.convId);
    adopt(convIdFromUrl(page.url()));
    if (tracker.turnDone) { why = 'ws-complete'; break; }
    if (tracker.sseDone && !tracker.wsActive) { why = 'sse-complete'; break; }
    if (tracker.status && tracker.status >= 400) { why = 'http-error'; break; }
    // SSE aborted and nothing ever arrived on the WebSocket: stop waiting for a push.
    if (tracker.failed && !tracker.wsActive && Date.now() - t0 > 20000) { why = 'no-stream'; break; }
    // Stream went silent for very long (dropped socket): let the server tell us.
    if (tracker.wsActive && Date.now() - tracker.wsLast > 5 * 60 * 1000) { why = 'ws-silent'; break; }
    if (Date.now() - lastProgress >= 30000) {
      lastProgress = Date.now();
      const len = (await domAnswer(page)).length;
      log(`ChatGPT is working ... ${secs()}s${len ? `, ~${len} chars on screen` : ''}`);
    }
    await sleep(200);
  }
  adopt(tracker.convId);
  adopt(convIdFromUrl(page.url()));

  if (why === 'http-error') {
    for (let i = 0; i < 25 && !tracker.sseDone; i++) await sleep(200); // let the error body arrive
    if (tracker.status === 429) throw new Error('ChatGPT says: too many requests (429) — wait a few minutes and retry');
    throw new Error(`ChatGPT rejected the message: ${sseError(tracker.body) || `HTTP ${tracker.status}`}`);
  }
  if (why === 'no-stream') log(`stream dropped (${tracker.failed}) and no live updates arrived — reading the result from the server`);
  if (why === 'ws-silent') log('live updates went silent for 5 min — checking the server');
  if (crashed || page.isClosed()) throw new Error('the ChatGPT tab crashed while answering — the answer may still be fetched with: fetch');

  // The URL can lag behind the stream; give it a moment.
  for (let i = 0; i < 20 && !convId; i++) {
    await sleep(250);
    adopt(convIdFromUrl(page.url()));
  }
  if (!convId) {
    const r = await api(page, '/backend-api/conversations?offset=0&limit=1&order=updated');
    const it = r.ok && r.json && r.json.items && r.json.items[0];
    if (it && it.id) {
      log('conversation id not in URL — using the most recent conversation ' + it.id);
      adopt(it.id);
    }
  }
  if (!convId) {
    const text = await domAnswer(page);
    return { text, convId: null, truncated: !tracker.finished, partial: false, via: 'dom', apiCalls: 1, secs: secs() };
  }

  // ---- Phase B + C ----
  const delays = [0, 2, 3, 5, 8, 12, 20, 30, 45, 60];
  let apiCalls = 0;
  let last = null;
  let idleStrikes = 0;
  let missingSince = null;
  let apiFails = 0;
  let notedBusy = false;
  for (let k = 0; ; k++) {
    const d = delays[Math.min(k, delays.length - 1)] * 1000;
    if (Date.now() + d > deadline) break;
    if (d) await sleep(d);
    apiCalls++;
    const r = await readConversation(page, convId);
    if (!r.ok) {
      apiFails++;
      if (r.status === 429) {
        log('rate limited while reading (429) — backing off');
        await sleep(30000);
      }
      if (r.status === 404 && k < 3) continue; // brand-new conversation not readable yet
      if (apiFails >= 4) {
        log(`reading the conversation failed ${apiFails}x (${r.status} ${String(r.error).slice(0, 80)}) — falling back to the page text`);
        return { text: await domAnswer(page), convId, truncated: !tracker.finished, partial: false, via: 'dom', apiCalls, secs: secs() };
      }
      continue;
    }
    apiFails = 0;
    const a = analyzeTurn(r.json, { knownIds, prompt });
    last = a;
    if (a.state === 'done') {
      if (!a.promptMatch) log('note: the latest user message differs from the prompt we typed (ChatGPT may have rewritten it)');
      return { text: a.text, convId, truncated: false, partial: a.partial, via: k ? 'api-poll' : 'api', apiCalls, secs: secs(), title: a.title };
    }
    if (a.state === 'error') throw new Error('ChatGPT error: ' + a.error);
    if (a.state === 'done-empty') {
      return { text: '', convId, truncated: false, partial: false, via: 'api', apiCalls, secs: secs(), note: 'turn finished without any text (image/tool-only answer?)' };
    }
    if (a.state === 'missing') {
      missingSince = missingSince || Date.now();
      const err = sseError(tracker.body);
      if (err && Date.now() - missingSince > 5000) throw new Error('ChatGPT rejected the message: ' + err);
      if (Date.now() - missingSince > 90000) throw new Error('the message never showed up in the conversation — it was probably not accepted');
      continue;
    }
    missingSince = null;
    if (a.state === 'generating') {
      idleStrikes = 0;
      if (!notedBusy) {
        notedBusy = true;
        log('the stream closed but ChatGPT is still working (long research/thinking) — polling with backoff');
      } else if (k % 3 === 0) {
        log(`still working ... ${secs()}s${a.text ? `, ${a.text.length} chars so far` : ''}`);
      }
      continue;
    }
    // idle: nothing running, but no end-of-turn marker either.
    if (++idleStrikes >= 4) {
      if (a.text) return { text: a.text, convId, truncated: false, partial: true, via: 'api-idle', apiCalls, secs: secs(), title: a.title };
      throw new Error('ChatGPT stopped without answering' + (sseError(tracker.body) ? ': ' + sseError(tracker.body) : ''));
    }
  }

  // Deadline: salvage whatever exists, clearly flagged.
  let text = last && last.text;
  if (!text) text = await domAnswer(page);
  return { text: text || '', convId, truncated: true, partial: true, via: 'timeout', apiCalls, secs: secs() };
}

// ---------------------------------------------------------------------------
// Model picker (best effort — UI-dependent)
// ---------------------------------------------------------------------------

const MODEL_BTN =
  'button[aria-haspopup="menu"][aria-label*="模型"], button[aria-haspopup="menu"][aria-label*="model" i], button[data-testid="model-switcher-dropdown-button"]';
const MENU_ITEMS = '[role="menuitem"], [role="menuitemradio"]';

async function openModelMenu(page) {
  const btn = page.locator(MODEL_BTN).first();
  try {
    await btn.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    return null;
  }
  await btn.click({ timeout: 5000 });
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const items = await page.evaluate(
      (sel) =>
        [...document.querySelectorAll(sel)]
          .filter((e) => e.getBoundingClientRect().width > 0)
          .map((e) => (e.innerText || '').split('\n')[0].trim())
          .filter(Boolean),
      MENU_ITEMS,
    );
    if (items.length) return items;
  }
  return [];
}

async function selectModel(page, name) {
  const items = await openModelMenu(page);
  if (!items || !items.length) {
    if (items) await page.keyboard.press('Escape').catch(() => {});
    log(`model picker not found — keeping the current model (wanted "${name}")`);
    return;
  }
  const picked = await page.evaluate((want) => {
    const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const w = norm(want);
    const els = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].filter((e) => e.getBoundingClientRect().width > 0);
    const first = (e) => norm((e.innerText || '').split('\n')[0]);
    const hit = els.find((e) => first(e) === w) || els.find((e) => first(e).startsWith(w)) || els.find((e) => first(e).includes(w));
    if (!hit) return null;
    hit.click();
    return (hit.innerText || '').split('\n')[0].trim();
  }, name);
  await sleep(500);
  await page.keyboard.press('Escape').catch(() => {});
  if (picked) log(`model: ${picked}`);
  else log(`model "${name}" not found — keeping the current one. Available: ${items.join(' | ')}`);
}

// ---------------------------------------------------------------------------
// One full ask
// ---------------------------------------------------------------------------

/** Before typing into an existing conversation, let any running turn finish (sending would abort it). */
async function prepareExistingConv(page, conv, deadline) {
  const delays = [0, 5, 10, 20, 30, 60];
  for (let k = 0; ; k++) {
    const r = await readConversation(page, conv);
    if (!r.ok) {
      if (r.status === 404) throw new Error(`conversation ${conv} not found (deleted, or another account) — use --new`);
      log(`could not read conversation before sending (${r.status}) — continuing`);
      return null;
    }
    const nodes = threadPath(r.json);
    const busy = (r.json.async_status !== null && r.json.async_status !== undefined) || nodes.some((n) => n.message.status === 'in_progress');
    if (!busy) return new Set(nodes.map((n) => n.id));
    if (k === 0) log('this conversation is still generating a previous answer — waiting so we do not abort it');
    const d = delays[Math.min(k + 1, delays.length - 1)] * 1000;
    if (Date.now() + d > deadline - 60000) {
      log('previous answer is still running — sending anyway');
      return new Set(nodes.map((n) => n.id));
    }
    await sleep(d);
  }
}

async function doAsk(page, p) {
  const deadline = Date.now() + p.timeout;
  const conv = p.conv || null;
  // Before navigating, so the WebSocket the page opens on load is observed.
  const tracker = trackSend(page, conv);
  let res;
  try {
    await page.bringToFront().catch(() => {});
    await openChat(page, conv ? `${ORIGIN}/c/${conv}` : `${ORIGIN}/`);
    if (conv && convIdFromUrl(page.url()) !== conv) {
      throw new Error(`conversation ${conv} did not open (redirected to ${page.url()}) — use --new`);
    }
    const knownIds = conv ? await prepareExistingConv(page, conv, deadline) : null;
    if (p.model) await selectModel(page, p.model);

    await clearComposer(page);
    if (p.images.length) await uploadFiles(page, p.images);
    await fillComposer(page, p.prompt);

    tracker.arm();
    await sendPrompt(page, tracker);
    log(conv ? `sent (conversation ${conv}) — waiting for the answer` : 'sent (new chat) — waiting for the answer');
    res = await waitForAnswer(page, { tracker, conv, knownIds, prompt: p.prompt, deadline, onConv: p.onConv });
  } finally {
    tracker.dispose();
  }

  let title = res.title || null;
  if (!conv && res.convId && p.rename) {
    const base = (p.title || p.prompt.split('\n')[0]).replace(/^\[AGENT\]\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const want = AGENT_PREFIX + (base || 'conversation');
    const r = await api(page, `/backend-api/conversation/${res.convId}`, { method: 'PATCH', body: { title: want } });
    if (r.ok) title = want;
    else log(`rename failed (${r.status})`);
  }
  return { ...res, title };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Write to stdout and wait for it to flush (process.exit can truncate pipes otherwise). */
const out = (s) => new Promise((r) => process.stdout.write(s.endsWith('\n') ? s : s + '\n', () => r()));

function resolveConv(o) {
  if (o.newChat) return null;
  if (o.conv) return o.conv;
  const s = getSessionConv(o.session);
  if (s) return s;
  if (o.continueLast) return readJson(LAST_FILE, {}).conversationId || null;
  return null;
}

/** Lock, attach, ask, release. Returns the result object (does not print the answer). */
async function runAsk(prompt, o, convOverride) {
  const images = o.images.map((f) => path.resolve(f));
  for (const f of images) if (!fs.existsSync(f)) throw new Error('file not found: ' + f);
  const conv = convOverride !== undefined ? convOverride : resolveConv(o);
  if (o.session && conv) log(`session "${o.session}" -> conversation ${conv}`);

  await acquireLock(prompt.slice(0, 80));
  const onSignal = (sig) => {
    log(`interrupted (${sig}). ChatGPT keeps working server-side; collect the answer later with: ` +
      `node chatgpt.mjs fetch ${o.session ? '-s ' + o.session : conv ? '--conv ' + conv : ''} --wait`.replace('  ', ' '));
    releaseLock();
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const { ctx } = await connect({ headless: o.headless });
    const page = await getChatPage(ctx);
    const onConv = (id) => {
      saveLast(id);
      if (o.session) saveSession(o.session, id);
    };
    const res = await doAsk(page, {
      prompt, conv, images, model: o.model, timeout: o.timeout,
      rename: !o.noRename, title: o.title, onConv,
    });
    if (res.convId) {
      saveLast(res.convId);
      if (o.session) saveSession(o.session, res.convId, res.title);
    }
    return res;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    releaseLock();
  }
}

async function cmdAsk(prompt, o) {
  if (!prompt || !prompt.trim()) throw new Error('empty prompt. Usage: chatgpt.mjs ask "<question>"');
  const r = await runAsk(prompt.trim(), o);
  const answer = cleanAnswer(r.text);
  if (o.save) {
    fs.writeFileSync(o.save, answer + '\n', 'utf8');
    log('saved answer to ' + o.save);
  }
  if (r.note) log('note: ' + r.note);
  if (r.partial && !r.truncated) log('warning: ChatGPT marked this answer as cut short (partial completion)');
  log(`done in ${r.secs}s via ${r.via} | api reads: ${r.apiCalls} | conversation_id: ${r.convId || '?'}`);
  if (r.title) log('title: ' + r.title);
  log('follow up with: ' + (o.session ? `-s ${o.session}` : r.convId ? `--conv ${r.convId}` : '--no-new'));
  if (r.truncated) {
    await out(
      `[INCOMPLETE ANSWER — ChatGPT was still working after ${r.secs}s. The text below is PARTIAL. ` +
        'Do not treat it as final and do not send a follow-up yet. Collect the finished answer with: ' +
        `node chatgpt.mjs fetch ${o.session ? '-s ' + o.session : '--conv ' + (r.convId || '<id>')} --wait]\n`,
    );
  }
  await out(answer);
  return r.truncated ? EXIT_INCOMPLETE : 0;
}

/** Read the latest answer of a conversation without sending anything (recovery path). */
async function cmdFetch(o) {
  const conv = o.conv || getSessionConv(o.session) || readJson(LAST_FILE, {}).conversationId;
  if (!conv) throw new Error('no conversation: pass --conv <id> or -s <session> (or ask something first)');
  const c = await connect({ headless: o.headless });
  let page = c.ctx.pages().find((p) => p.url().startsWith(ORIGIN));
  let temp = false;
  if (!page) {
    page = await c.ctx.newPage();
    temp = true;
    await gotoRetry(page, ORIGIN + '/');
  }
  try {
    const deadline = Date.now() + (o.wait ? o.timeout : 0);
    const delays = [0, 5, 10, 20, 30, 60];
    for (let k = 0; ; k++) {
      const r = await readConversation(page, conv);
      if (!r.ok) throw new Error(`could not read conversation ${conv}: ${r.status} ${String(r.error).slice(0, 120)}`);
      const a = analyzeTurn(r.json, {});
      if (a.state === 'error') throw new Error('ChatGPT error: ' + a.error);
      const finished = a.state === 'done' || a.state === 'done-empty' || a.state === 'missing';
      const d = delays[Math.min(k + 1, delays.length - 1)] * 1000;
      if (finished || !o.wait || Date.now() + d > deadline) {
        log(`conversation ${conv}: ${a.state}${a.title ? ' | ' + a.title : ''}`);
        if (!finished) {
          await out('[INCOMPLETE ANSWER — ChatGPT is still working on this conversation. Re-run: fetch --wait]\n');
        }
        await out(cleanAnswer(a.text));
        return finished ? 0 : EXIT_INCOMPLETE;
      }
      if (k === 0) log('still generating — waiting (polling with backoff) ...');
      await sleep(d);
    }
  } finally {
    if (temp) await page.close().catch(() => {});
  }
}

async function cmdChat(o) {
  let conv = resolveConv(o);
  log('interactive: one prompt per line; empty line / "exit" / Ctrl+D ends.');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const raw of rl) {
    const prompt = raw.trim();
    if (!prompt || prompt === 'exit' || prompt === 'quit') break;
    try {
      const r = await runAsk(prompt, { ...o, images: [] }, conv);
      conv = r.convId || conv;
      if (r.truncated) await out('[INCOMPLETE ANSWER]');
      await out(cleanAnswer(r.text) + '\n');
      log(`conversation_id: ${conv || '?'}`);
    } catch (e) {
      log('ERROR: ' + e.message);
    }
  }
  return 0;
}

async function cmdList(o) {
  const c = await connect({ headless: o.headless });
  let page = c.ctx.pages().find((p) => p.url().startsWith(ORIGIN));
  let temp = false;
  if (!page) {
    page = await c.ctx.newPage();
    temp = true;
    await gotoRetry(page, ORIGIN + '/');
  }
  try {
    const r = await api(page, `/backend-api/conversations?offset=0&limit=${o.limit}&order=updated`);
    if (!r.ok) throw new Error(`list failed: ${r.status} ${String(r.error).slice(0, 120)}`);
    let items = ((r.json && r.json.items) || []).map((it) => ({ id: it.id, title: it.title || '', updated: it.update_time || '' }));
    if (o.agentOnly) items = items.filter((it) => /^\[AGENT\]/i.test(it.title));
    if (o.json) await out(JSON.stringify(items, null, 2));
    else await out(items.length ? items.map((it) => `${it.id}\t${it.title}`).join('\n') : '(no conversations)');
    return 0;
  } finally {
    if (temp) await page.close().catch(() => {});
  }
}

async function cmdSessions(o) {
  const all = readSessions();
  if (o._[0] === '--forget' || o._[0] === 'forget') {
    const name = o._[1];
    if (!name || !all[name]) return out('no such session: ' + name).then(() => 1);
    delete all[name];
    writeJsonAtomic(SESSIONS_FILE, all);
    await out('forgot session: ' + name);
    return 0;
  }
  if (o.json) await out(JSON.stringify(all, null, 2));
  else {
    const names = Object.keys(all);
    await out(names.length ? names.map((n) => `${n}\t${all[n].conversationId}\t${all[n].title || ''}`).join('\n') : '(no named sessions) — create one with: ask "..." -s <name>');
  }
  return 0;
}

async function cmdModels(o) {
  await acquireLock('models');
  try {
    const { ctx } = await connect({ headless: o.headless });
    const page = await getChatPage(ctx);
    await openChat(page, ORIGIN + '/');
    const items = await openModelMenu(page);
    await page.keyboard.press('Escape').catch(() => {});
    if (!items || !items.length) throw new Error('model picker not found on the page');
    await out(items.join('\n'));
    return 0;
  } finally {
    releaseLock();
  }
}

async function cmdStatus() {
  const c = await connect({ launch: false });
  if (!c) {
    await out('BROWSER_NOT_RUNNING');
    log('it starts automatically on the next ask (or: node chatgpt.mjs start)');
    return 0;
  }
  let page = c.ctx.pages().find((p) => p.url().startsWith(ORIGIN));
  let temp = false;
  if (!page) {
    page = await c.ctx.newPage();
    temp = true;
    await gotoRetry(page, ORIGIN + '/');
  }
  try {
    const s = await getSessionInfo(page);
    const owner = lockOwner();
    await out(!s.ok ? 'UNKNOWN: ' + (s.error || 'session check failed') : s.authed ? 'OK: logged in' : 'NOT_LOGGED_IN');
    log(`browser on CDP port ${c.port}` + (s.email ? ` | account ${s.email}` : ''));
    if (owner && ownerAlive(owner)) log(`busy: pid ${owner.pid} has been asking for ${Math.round((Date.now() - owner.since) / 1000)}s`);
    if (s.ok && !s.authed) log('fix: node chatgpt.mjs login   (or: node chatgpt.mjs sync)');
    return 0;
  } finally {
    if (temp) await page.close().catch(() => {});
  }
}

async function cmdStart(o) {
  const { ctx, port } = await connect({ headless: o.headless });
  const page = await getChatPage(ctx);
  if (!page.url().startsWith(ORIGIN)) await gotoRetry(page, ORIGIN + '/');
  const s = await getSessionInfo(page);
  await out(`OK: browser running on CDP port ${port}` + (s.authed ? ' (logged in)' : ' (NOT logged in — run: login)'));
  return 0;
}

async function stopBrowser() {
  await stopLegacyDaemon();
  const pid = readJson(BROWSER_STATE, {}).pid || profileLockPid();
  const c = await connect({ launch: false }).catch(() => null);
  if (c) {
    try {
      const s = await c.browser.newBrowserCDPSession();
      await s.send('Browser.close').catch(() => {});
    } catch {
      /* fall through to signals */
    }
  }
  const lockPid = profileLockPid();
  for (let i = 0; i < 25 && (isPidAlive(lockPid) || isPidAlive(pid)); i++) await sleep(200);
  for (const p of [lockPid, pid]) {
    if (p && isPidAlive(p) && (pidCmdline(p) || '').includes(PROFILE_DIR)) await killPid(p, 'browser');
  }
  return !!c;
}

async function cmdStop() {
  const owner = lockOwner();
  if (owner && ownerAlive(owner)) log(`warning: an ask (pid ${owner.pid}) is running — it will fail`);
  const was = await stopBrowser();
  await out(was ? 'OK: browser stopped' : 'browser was not running');
  return 0;
}

async function cmdLogin() {
  const st = readJson(BROWSER_STATE, {});
  if (st.headless) await stopBrowser(); // login needs a visible window
  const { ctx } = await connect({ headless: false });
  const page = await getChatPage(ctx);
  await page.bringToFront().catch(() => {});
  await gotoRetry(page, ORIGIN + '/');
  log('log into ChatGPT in the browser window (waiting up to 5 minutes) ...');
  const end = Date.now() + 5 * 60 * 1000;
  while (Date.now() < end) {
    const s = await getSessionInfo(page);
    if (s.authed) {
      await out('OK: logged in' + (s.email ? ' as ' + s.email : ''));
      return 0;
    }
    await sleep(3000);
  }
  throw new Error('timed out waiting for login — run "login" again');
}

async function cmdSync() {
  await stopBrowser();
  const src = process.env.ASK_CHATGPT_SOURCE_PROFILE || path.join(os.homedir(), '.config', 'google-chrome');
  const prof = process.env.ASK_CHATGPT_CHROME_PROFILE || 'Default';
  const from = path.join(src, prof);
  if (!fs.existsSync(path.join(from, 'Cookies'))) {
    throw new Error(`Chrome cookies not found at ${from}\nSet ASK_CHATGPT_SOURCE_PROFILE / ASK_CHATGPT_CHROME_PROFILE (e.g. "Profile 1").`);
  }
  fs.mkdirSync(path.join(PROFILE_DIR, 'Default'), { recursive: true });
  for (const f of ['Cookies', 'Cookies-journal']) {
    const s = path.join(from, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(PROFILE_DIR, 'Default', f));
  }
  const ls = path.join(src, 'Local State');
  if (fs.existsSync(ls)) fs.copyFileSync(ls, path.join(PROFILE_DIR, 'Local State'));
  log(`copied cookies ${from} -> ${PROFILE_DIR}`);
  log('note: cookies decrypt only with the same browser family they came from (Chrome vs Chromium).');
  return cmdStart({ headless: false });
}

function printHelp() {
  return out(`ask-chatgpt v2 — ask the ChatGPT web app (web search, reasoning, images) from the terminal

  ask "<prompt>" [flags]     Send a prompt, print the answer on stdout.  (prompt may come from stdin)
  fetch [-s name|--conv id] [--wait]
                             Print the latest answer of a conversation without sending anything.
                             Use it after an INCOMPLETE answer or an interrupted ask.
  chat [-s name]             Interactive: one prompt per line.
  sessions [--forget <name>] Named sessions.     list [--limit n] [--agent-only] [--json]
  models                     List the models offered in the model picker.
  status | start | stop      Browser + login state / start it / close it.
  login | sync               Log in manually in the window / copy cookies from your Chrome.

Ask flags:
  -s, --session <name>   Multi-turn: continue (or create) this named conversation.
  --conv <id>            Continue a specific conversation id.     --no-new  continue the last one.
  --new                  Force a new chat (also rebinds -s <name>).
  -i, --image <path>     Attach an image/file (repeatable).
  -m, --model <name>     Pick a model from the picker (see: models).
  --timeout <ms>         Max wait (default ${DEFAULT_TIMEOUT}).    --save <path>  also write the answer.
  --title <t> / --no-rename   Title of a new chat ("[AGENT] ..." by default).

Exit codes: 0 answer complete | 1 error | 3 INCOMPLETE (partial; collect later with "fetch --wait").
Asks are serialized automatically (one ChatGPT login) — concurrent callers wait their turn.
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('[ask-chatgpt] ERROR: ' + e.message);
    return 1;
  }
  const cmd = o._.shift();
  if (o.help || !cmd || cmd === 'help') {
    await printHelp();
    return cmd || o.help ? 0 : 1;
  }
  switch (cmd) {
    case 'ask': {
      let prompt = o._.join(' ').trim();
      if (!prompt && !process.stdin.isTTY) prompt = fs.readFileSync(0, 'utf8').trim();
      return cmdAsk(prompt, o);
    }
    case 'fetch': case 'get': return cmdFetch(o);
    case 'chat': return cmdChat(o);
    case 'list': case 'ls': return cmdList(o);
    case 'sessions': return cmdSessions(o);
    case 'models': return cmdModels(o);
    case 'status': return cmdStatus(o);
    case 'start': return cmdStart(o);
    case 'stop': return cmdStop(o);
    case 'login': return cmdLogin(o);
    case 'sync': return cmdSync(o);
    case 'daemon':
      log('v2 has no daemon — the browser runs on its own. Use "start".');
      return cmdStart(o);
    default:
      console.error('Unknown command: ' + cmd);
      await printHelp();
      return 1;
  }
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error('[ask-chatgpt] ERROR: ' + (e && e.message ? e.message : e));
    process.exit(1);
  });
