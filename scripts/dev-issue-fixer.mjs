#!/usr/bin/env node
// scripts/dev-issue-fixer.mjs
//
// "Pass to Developer" — local AI auto-fix runner.
//
// This watcher runs on a DEVELOPER MACHINE, where the repo and the Claude Code CLI
// live. The cloud admin portal only queues work; this script does the actual fixing:
//
//   1. Poll  GET  $AURA_BASE_URL/.netlify/functions/admin-issue-handoff?action=claim
//   2. For each claimed issue:
//        • create an isolated git worktree on a new branch off $BASE_BRANCH
//        • run Claude Code headless (`claude -p … --permission-mode acceptEdits`) to fix it
//        • commit, push, and open a PR with `gh`
//   3. POST the result back; the issue parks at "Fix In Progress" with a PR ready to merge.
//
// It ALSO drains the merge queue: when a super-admin presses "Merge to staging" in the
// admin ticket, this watcher claims that request (?action=claim-merge), runs `gh pr merge`,
// and reports back (?action=merge-result) — which is what finally flips the issue to
// "Fixed & Ready to Test".
//
// Nothing here touches your current working tree — all edits happen in a throwaway
// worktree under the OS temp dir, which is removed when the issue is done.
//
// Required env:
//   AURA_BASE_URL      e.g. https://staging--bemoreswan.netlify.app  (or http://localhost:8888)
//   DEV_HANDOFF_TOKEN  must match the same env var on the Netlify deployment
// Optional env:
//   AURA_REPO          path to the repo (default: the repo this script lives in)
//   BASE_BRANCH        branch to fork fixes from (default: staging)
//   POLL_INTERVAL_MS   idle poll cadence (default: 15000)
//   CLAUDE_BIN         Claude Code CLI binary (default: claude)
//   ONCE=1             process at most one issue then exit (handy for testing)
//
// Run:  npm run dev:issue-fixer

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = (process.env.AURA_BASE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.DEV_HANDOFF_TOKEN || '';
const REPO = process.env.AURA_REPO || join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_BRANCH = process.env.BASE_BRANCH || 'staging';
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 15000);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const ONCE = process.env.ONCE === '1';

const ENDPOINT = `${BASE_URL}/.netlify/functions/admin-issue-handoff`;

if (!BASE_URL || !TOKEN) {
  console.error('✖ AURA_BASE_URL and DEV_HANDOFF_TOKEN are required.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Run a command, returning { ok, stdout, stderr }. Never throws.
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim() || (r.error ? String(r.error.message) : ''),
  };
}
const git = (args, opts = {}) => run('git', ['-C', opts.cwd || REPO, ...args], opts);

// Resilient JSON fetch to the handoff endpoint.
//
// Why this exists: a fix can take MINUTES (the Claude Code run) between claiming an
// issue and reporting the result. Node's global fetch (undici) pools keep-alive
// sockets; after that long idle gap the server has usually closed the pooled socket,
// so the *first* request afterwards — the success report — reuses a dead socket and
// rejects with the opaque `TypeError: fetch failed` (cause ECONNRESET / "other side
// closed"). The next request gets a fresh socket and works, which is exactly why the
// failure report always lands while the success report didn't.
//
// We defend on three fronts: send `Connection: close` so no socket is ever pooled,
// retry connection-level failures on a fresh connection, and — if we still give up —
// surface the underlying cause so the recorded message is actionable instead of just
// "fetch failed".
async function apiFetch(url, init = {}, { tries = 3, label = 'request' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fetch(url, { ...init, headers: { Connection: 'close', ...(init.headers || {}) } });
    } catch (e) {
      lastErr = e;
      const cause = e?.cause;
      const code = cause?.code || cause?.message || '';
      log(`  ${label} fetch attempt ${attempt}/${tries} failed: ${e.message}${code ? ` (${code})` : ''}`);
      if (attempt < tries) await sleep(500 * attempt);
    }
  }
  const cause = lastErr?.cause;
  const detail = cause ? ` — ${cause.code || cause.message || String(cause)}` : '';
  throw new Error(`${lastErr?.message || 'fetch failed'}${detail}`);
}

async function claimNext() {
  const res = await apiFetch(`${ENDPOINT}?action=claim`, {
    headers: { 'x-handoff-token': TOKEN },
  }, { label: 'claim' });
  if (!res.ok) throw new Error(`claim failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.issue || null;
}

async function report(id, payload) {
  const res = await apiFetch(`${ENDPOINT}?id=${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-handoff-token': TOKEN },
    body: JSON.stringify(payload),
  }, { label: 'report' });
  if (!res.ok) throw new Error(`report failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function claimMerge() {
  const res = await apiFetch(`${ENDPOINT}?action=claim-merge`, {
    headers: { 'x-handoff-token': TOKEN },
  }, { label: 'claim-merge' });
  if (!res.ok) throw new Error(`claim-merge failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.issue || null;
}

async function reportMerge(id, payload) {
  const res = await apiFetch(`${ENDPOINT}?id=${id}&action=merge-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-handoff-token': TOKEN },
    body: JSON.stringify(payload),
  }, { label: 'merge-result' });
  if (!res.ok) throw new Error(`merge-result failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const SQL_START = '---SQL-MIGRATION-START---';
const SQL_END = '---SQL-MIGRATION-END---';

function buildPrompt(issue) {
  return [
    `You are an autonomous developer fixing a bug reported by a user of the Aura / "Be More Swan" app.`,
    `Work in the current repository. Make the smallest, safest change that fixes the issue.`,
    `Do NOT run any git commands and do NOT commit — only edit files. The harness handles git, the branch, and the pull request.`,
    ``,
    `DATABASE CHANGES: this project never uses drizzle-kit push — schema changes ship as idempotent hand-written SQL in db/*.sql, applied manually. If (and only if) your fix needs a database change:`,
    `  1. Add the idempotent SQL to the appropriate db/*.sql file (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / guarded constraints), and update db/schema.ts to match.`,
    `  2. ALSO output the exact SQL to run, wrapped EXACTLY between these markers on their own lines:`,
    `       ${SQL_START}`,
    `       <the idempotent SQL>`,
    `       ${SQL_END}`,
    `  A super-admin will review and run that SQL against staging from the issue ticket. Omit the markers entirely if no DB change is needed.`,
    ``,
    `When you are done, end your reply with a short plain-text summary of the root cause and exactly what you changed (file names + why).`,
    ``,
    `--- ISSUE #${issue.id} ---`,
    `Reported by: ${issue.reporterName || 'a user'}`,
    `Location in app: ${issue.sourceLocation || 'unknown'}`,
    issue.sourceUrl ? `URL: ${issue.sourceUrl}` : '',
    issue.hasImage ? `(The reporter attached a screenshot, available in the admin portal.)` : '',
    ``,
    `Description:`,
    issue.description || '(no description provided)',
  ].filter(Boolean).join('\n');
}

// Split Claude's output into the migration SQL (between the markers) and the human
// summary (everything else, with any leftover ```sql fences from the block stripped).
function extractMigrationSql(out) {
  const start = out.indexOf(SQL_START);
  const end = out.indexOf(SQL_END);
  if (start === -1 || end === -1 || end < start) return { sql: null, summary: out.trim() };
  let sql = out.slice(start + SQL_START.length, end).trim();
  sql = sql.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim(); // tolerate fenced SQL
  const summary = (out.slice(0, start) + out.slice(end + SQL_END.length)).replace(/\n{3,}/g, '\n\n').trim();
  return { sql: sql || null, summary: summary || 'A fix has been produced.' };
}

async function processIssue(issue) {
  const id = issue.id;
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const branch = `fix/issue-${id}-${ts}`;
  let worktree = null;

  try {
    log(`#${id} fetching origin…`);
    git(['fetch', 'origin', '--quiet']);

    // Prefer the remote base branch; fall back to a local one.
    const baseRef = git(['rev-parse', '--verify', `origin/${BASE_BRANCH}`]).ok
      ? `origin/${BASE_BRANCH}` : BASE_BRANCH;

    worktree = mkdtempSync(join(tmpdir(), `aura-issue-${id}-`));
    log(`#${id} creating worktree on ${branch} from ${baseRef}`);
    const wt = git(['worktree', 'add', '-b', branch, worktree, baseRef]);
    if (!wt.ok) throw new Error(`worktree add failed: ${wt.stderr}`);

    log(`#${id} running Claude Code…`);
    const claude = run(CLAUDE_BIN, ['-p', '--permission-mode', 'acceptEdits'], {
      cwd: worktree,
      input: buildPrompt(issue),
    });
    const rawOut = claude.stdout || claude.stderr || 'No output from the AI runner.';
    if (!claude.ok) throw new Error(`Claude Code exited ${claude.code}: ${claude.stderr || claude.stdout}`);

    // Pull out the migration SQL (if any) and keep it out of the human summary.
    const { sql: migrationSql, summary } = extractMigrationSql(rawOut);
    if (migrationSql) log(`#${id} fix includes a DB migration (${migrationSql.length} chars) — will be run from the ticket`);

    // Did it actually change anything?
    const status = git(['status', '--porcelain'], { cwd: worktree });
    if (!status.stdout) {
      throw new Error(`Claude Code produced no file changes.\n\nAI notes:\n${summary}`);
    }

    log(`#${id} committing + pushing…`);
    const add = git(['add', '-A'], { cwd: worktree });
    if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);
    const commit = git(['commit', '-m', `fix: issue #${id} (AI auto-fix)\n\n${summary}\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`], { cwd: worktree });
    if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`);
    const push = git(['push', '-u', 'origin', branch], { cwd: worktree });
    if (!push.ok) throw new Error(`git push failed: ${push.stderr}`);

    log(`#${id} opening pull request…`);
    const prBody = `Automated fix for reported issue #${id}.\n\n**Location:** ${issue.sourceLocation || 'unknown'}\n\n**Reported description:**\n${issue.description || ''}\n\n**AI summary:**\n${summary}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
    const pr = run('gh', ['pr', 'create', '--base', BASE_BRANCH, '--head', branch,
      '--title', `Fix: issue #${id} — ${(issue.sourceLocation || 'reported issue').slice(0, 60)}`,
      '--body', prBody], { cwd: worktree });
    const prUrl = pr.ok ? (pr.stdout.match(/https?:\/\/\S+/) || [])[0] || pr.stdout : null;
    if (!pr.ok) log(`#${id} ⚠ gh pr create failed (branch still pushed): ${pr.stderr}`);

    log(`#${id} reporting success${prUrl ? ` — ${prUrl}` : ''}${migrationSql ? ' (+SQL pending)' : ''}`);
    await report(id, { ok: true, summary, branch, prUrl, sql: migrationSql });
    log(`#${id} ✓ done`);
  } catch (e) {
    log(`#${id} ✖ ${e.message}`);
    await report(id, { ok: false, summary: e.message }).catch((re) => log(`#${id} ✖ could not report failure: ${re.message}`));
  } finally {
    if (worktree) {
      git(['worktree', 'remove', '--force', worktree]);
      try { rmSync(worktree, { recursive: true, force: true }); } catch {}
    }
  }
}

// Merge an already-produced fix PR into staging with `gh pr merge`, then report back.
// Runs against the remote PR — no worktree/checkout needed. Branch cleanup is best-effort
// and never fails the merge.
async function processMerge(job) {
  const id = job.id;
  const target = job.prUrl || job.branch;
  try {
    if (!target) throw new Error('No pull request URL or branch to merge.');
    log(`#${id} merging ${target} into ${BASE_BRANCH}…`);
    git(['fetch', 'origin', '--quiet']);

    const m = run('gh', ['pr', 'merge', target, '--merge'], { cwd: REPO });
    const outcome = (m.stdout || m.stderr || '').trim();
    if (!m.ok) throw new Error(outcome || 'gh pr merge failed');

    // Best-effort: delete the merged branch on the remote. Ignore failures.
    if (job.branch) git(['push', 'origin', '--delete', job.branch]);

    log(`#${id} ✓ merged to ${BASE_BRANCH}`);
    await reportMerge(id, { ok: true, outcome: outcome || `Merged ${target} into ${BASE_BRANCH}.` });
    log(`#${id} ✓ merge reported`);
  } catch (e) {
    log(`#${id} ✖ merge failed: ${e.message}`);
    await reportMerge(id, { ok: false, outcome: e.message })
      .catch((re) => log(`#${id} ✖ could not report merge failure: ${re.message}`));
  }
}

async function main() {
  log(`dev-issue-fixer watching ${ENDPOINT}`);
  log(`repo=${REPO} base=${BASE_BRANCH} poll=${POLL_MS}ms${ONCE ? ' once' : ''}`);
  let stop = false;
  process.on('SIGINT', () => { log('shutting down…'); stop = true; });

  while (!stop) {
    // 1) A fix to produce takes priority.
    let issue = null;
    try { issue = await claimNext(); }
    catch (e) { log(`poll error: ${e.message}`); }
    if (issue) {
      await processIssue(issue);
      if (ONCE) break;
      continue; // immediately check for more
    }

    // 2) Otherwise, a fix that's been approved for merge to staging.
    let merge = null;
    try { merge = await claimMerge(); }
    catch (e) { log(`merge poll error: ${e.message}`); }
    if (merge) {
      await processMerge(merge);
      if (ONCE) break;
      continue;
    }

    if (ONCE) { log('nothing queued; exiting (ONCE).'); break; }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
