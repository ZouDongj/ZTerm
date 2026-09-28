import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Sandbox root lives INSIDE the repo (artifacts/e2e-tmp), never in %TEMP% —
// hundreds of zterm-e2e-* / zterm-probe-* dirs accumulated in the user's temp
// dir before this rule existed. Every path registered here is removed on
// process exit; dirs older than an hour (left by killed runs) are swept when
// the next sandbox is created.
export const E2E_TMP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'e2e-tmp');

const exitCleanups = new Set();
let exitHookArmed = false;
function armExitHook() {
  if (exitHookArmed) return;
  exitHookArmed = true;
  process.on('exit', () => {
    for (const target of exitCleanups) {
      try { rmSync(target, { recursive: true, force: true }); } catch { /* locked by an orphan: left for the stale sweep */ }
    }
  });
}

// Register any scratch path (sandbox dir, WebView2 user-data folder, helper
// file) for best-effort removal when this process exits.
export function registerExitCleanup(target) {
  exitCleanups.add(target);
  armExitHook();
  return target;
}

function sweepStaleSandboxes(tempRoot) {
  const cutoff = Date.now() - 3_600_000;
  let entries;
  try { entries = readdirSync(tempRoot, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(tempRoot, entry.name);
    if (exitCleanups.has(full)) continue;
    let mtimeMs = 0;
    try { mtimeMs = statSync(full).mtimeMs; } catch { continue; }
    if (mtimeMs < cutoff) {
      try { rmSync(full, { recursive: true, force: true }); } catch { /* locked: try again next run */ }
    }
  }
}

export function createE2eSandbox(sourceExe, tempRoot = E2E_TMP_ROOT) {
  mkdirSync(tempRoot, { recursive: true });
  sweepStaleSandboxes(tempRoot);
  const directory = mkdtempSync(join(tempRoot, 'zterm-e2e-'));
  const exe = join(directory, 'zterm.exe');
  const appData = join(directory, 'appdata');
  mkdirSync(appData);
  mkdirSync(join(directory, 'data'));
  copyFileSync(resolve(sourceExe), exe);
  registerExitCleanup(directory);
  return { directory, exe, appData };
}

// Live probes that keep the REAL APPDATA (herdr session discovery only works
// under %APPDATA%\herdr) would otherwise leak the user's configuration into
// the sandbox: on first launch migrate_legacy_config() copies the anchor
// config (%APPDATA%\ZTerm\config.json — sshProfiles with DPAPI credentials,
// lastTabs) into the empty sandbox data dir, and the frontend then
// auto-reconnects the user's SSH tabs from the sandboxed instance.
// Pre-seeding an empty config makes that migration a no-op (the target
// exists) while sanitize_config merges it over the built-in defaults, so
// the sandbox behaves like a stock first run. When the anchor redirects the
// data dir via `dataDir`, the sandbox would read/write that real directory —
// refuse to run instead. Only the key's presence is inspected; no config
// content is read beyond the pointer itself.
export function seedIsolatedConfig(sandbox, appData = process.env.APPDATA) {
  const anchor = join(appData || '', 'ZTerm', 'config.json');
  if (existsSync(anchor)) {
    let pointer = null;
    try {
      pointer = JSON.parse(readFileSync(anchor, 'utf8'))?.dataDir;
    } catch { /* unparseable anchor: treated as no pointer */ }
    if (typeof pointer === 'string' && pointer) {
      throw new Error('anchor config sets a custom dataDir; the sandbox would share that real directory — aborting');
    }
  }
  const dataDir = join(sandbox.directory, 'data');
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, 'config.json');
  if (!existsSync(target)) writeFileSync(target, '{}\n');
  return target;
}

// ── Process ownership (batch 05) ────────────────────────────────────────────
// Rules enforced by every helper below:
//   1. Startup/debug-port discovery is READ-ONLY: an occupied or unqueryable
//      port is reported and skipped, never freed by killing its holder — an
//      image-name match proves nothing (the user may run their own ZTerm or
//      WebView2 from the same binaries).
//   2. Termination requires per-PID ownership evidence taken from a query
//      made for THIS decision, never from an earlier snapshot: pids get
//      reused and port holders get replaced underneath a long test run.
//      This includes retries: a kill may only follow a kill-or-verify
//      failure of a process that was just re-proven ours — never a mere
//      existence check.
//   3. OS queries distinguish successful-empty from failure (structured
//      envelope below). Unknown is never downgraded to free/gone/dead.
//   4. When ownership cannot be proven the process stays alive and the caller
//      receives an explicit report. No fallback ever widens the kill set.

export function ownsProcess(child, executable, actual) {
  return Boolean(child && Number.isInteger(child.pid) && child.pid > 0 &&
    child.exitCode === null && child.signalCode == null &&
    actual?.ProcessId === child.pid && typeof actual.ExecutablePath === 'string' &&
    resolve(actual.ExecutablePath).toLowerCase() === resolve(executable).toLowerCase());
}

// Certainty verdict for a process record's executable identity. A valid
// DIFFERENT path is positive evidence of pid reuse; an absent/unreadable/
// malformed path is 'unknown' and must never be used as positive evidence of
// death or foreign identity.
function executableVerdict(record, executable) {
  const path = record?.ExecutablePath;
  if (typeof path !== 'string' || path === '') return 'unknown';
  return resolve(path).toLowerCase() === resolve(executable).toLowerCase() ? 'owned' : 'foreign';
}

// Absolute-Windows-path form used for ownership comparisons: case-insensitive
// (NTFS), separators normalized, trailing separators dropped. Relative or
// non-path values yield null — they can never be proven equal to the sandbox.
function normalizedPath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('"')) return null;
  if (!/^([a-z]:[\\/]|\\\\)/i.test(value)) return null;
  try { return resolve(value).toLowerCase().replace(/[\\/]+$/, ''); } catch { return null; }
}

// Windows command-line tokenizer following the MSVCRT/CommandLineToArgvW
// argument rules: double quotes toggle quoting, 2n backslashes before a quote
// collapse to n (an odd backslash escapes the quote), backslashes elsewhere
// are literal, and a quote immediately followed by another quote inside a
// quoted argument is an escaped LITERAL quote that does not end the argument
// (pinned by the Node-child argv comparison in batch 05 — this is a rule-set
// implementation with boundary cases under test, not a claim of full
// equivalence). Returns null for a malformed line (unterminated quote) so
// callers reject the evidence instead of guessing at token boundaries.
function tokenizeWindowsCommandLine(line) {
  const tokens = [];
  let current = '';
  let started = false;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      let backslashes = 0;
      while (line[i] === '\\') { backslashes++; i++; }
      i--;
      const nextIsQuote = line[i + 1] === '"';
      current += '\\'.repeat(nextIsQuote ? backslashes >> 1 : backslashes);
      if (nextIsQuote && backslashes % 2 === 1) { current += '"'; i++; }
      started = true;
      continue;
    }
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; continue; } // escaped literal quote
      inQuotes = !inQuotes;
      started = true;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (started) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (inQuotes) return null;
  if (started) tokens.push(current);
  return tokens;
}

// The browser profile switch recognized as ownership evidence. Microsoft's
// CoreWebView2EnvironmentOptions.AdditionalBrowserArguments documentation
// names --user-data-dir as the switch important to WebView2 functionality and
// states that repeated switches use the last instance. Similar names such
// as --user-data-folder are not interchangeable evidence. Unsupported or
// ambiguous forms remain unknown; changes to the accepted switch contract
// require owned-runtime evidence, never a fallback to image or port matches.
const PROFILE_SWITCH = '--user-data-dir';

// Classify a browser command line's EFFECTIVE profile against this run's
// sandbox: 'owned' (positively our profile), 'foreign' (positively a valid
// different profile — evidence the process is not ours, without killing it),
// or 'unknown' (absent / malformed / ambiguous — never evidence of either).
// Only real switch tokens count: argv0 is skipped, everything after a bare
// `--` terminator is positional, and any bare (value-less) --user-data-dir
// occurrence makes the effective value undeterminable. Pure function.
export function sandboxProfileVerdict(commandLine, sandboxDirectory) {
  if (typeof commandLine !== 'string') return 'unknown';
  const sandbox = normalizedPath(sandboxDirectory);
  if (!sandbox) return 'unknown';
  const tokens = tokenizeWindowsCommandLine(commandLine);
  if (tokens === null || tokens.length === 0) return 'unknown'; // malformed → reject
  const prefix = PROFILE_SWITCH.toLowerCase() + '=';
  const values = [];
  for (let i = 1; i < tokens.length; i++) { // i=1: argv0 is the executable, never a switch
    const token = tokens[i];
    if (token === '--') break; // switch terminator: later tokens are positional data
    const lower = token.toLowerCase();
    if (lower === PROFILE_SWITCH.toLowerCase()) return 'unknown'; // bare override: effective value undeterminable
    if (!lower.startsWith(prefix)) continue;
    const value = normalizedPath(token.slice(prefix.length));
    if (value === null) return 'unknown'; // unparseable value at the effective position
    values.push(value);
  }
  if (values.length === 0) return 'unknown';
  if (values.some((value) => value !== values[values.length - 1])) return 'unknown'; // conflicting switches → ambiguous
  const effective = values[values.length - 1]; // documented last-instance rule
  return effective === sandbox || effective.startsWith(sandbox + '\\') ? 'owned' : 'foreign';
}

// Boolean convenience over the verdict for callers that only gate on
// ownership (enumeration candidacy etc.).
export function ownsSandboxProfile(commandLine, sandboxDirectory) {
  return sandboxProfileVerdict(commandLine, sandboxDirectory) === 'owned';
}

// ── Structured OS query protocol ────────────────────────────────────────────
// Every PowerShell query is wrapped so its stdout is a two-line envelope:
//     __ZT_OK__  + JSON payload   the query executed; the payload may be empty
//     __ZT_ERR__ + JSON message   the query itself failed (e.g. access denied)
// Queries are written so that "no results" is a SUCCESSFUL empty payload, not
// an error (e.g. listeners are filtered client-side instead of via
// -LocalPort, whose no-match case raises). Anything else — powershell.exe
// failing to run, a missing marker, unparsable JSON — is { ok: false }, never
// an empty success. $ErrorActionPreference='Stop' routes terminating errors
// (permissions, missing cmdlets) into the catch branch.
function runStructuredQuery(innerScript, { timeoutMs } = {}) {
  const script = `$ErrorActionPreference='Stop'\n$out = $null\ntry { $out = @( ${innerScript} ) } catch { Write-Output '__ZT_ERR__'; ConvertTo-Json -Compress -InputObject ([string]$_.Exception.Message); exit 0 }\nWrite-Output '__ZT_OK__'\nConvertTo-Json -Compress -InputObject @($out)`;
  let raw;
  try {
    raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script],
      { encoding: 'utf8', windowsHide: true, ...(Number.isInteger(timeoutMs) ? { timeout: timeoutMs } : {}) });
  } catch (e) {
    // Nonzero exit with captured stdout can still carry a well-formed
    // envelope; only a missing/unreadable output is "unavailable".
    raw = e && e.stdout != null ? e.stdout : null;
  }
  if (raw == null) return { ok: false, reason: 'unavailable' };
  const text = String(raw);
  const okAt = text.indexOf('__ZT_OK__');
  const errAt = text.indexOf('__ZT_ERR__');
  if (errAt >= 0 && (okAt < 0 || errAt < okAt)) {
    let message;
    try { message = JSON.parse(text.slice(errAt + 11).trim()); } catch { message = null; }
    return { ok: false, reason: 'query', error: typeof message === 'string' ? message : undefined };
  }
  if (okAt < 0) return { ok: false, reason: 'protocol' };
  let payload;
  try { payload = JSON.parse(text.slice(okAt + 9).trim()); } catch { return { ok: false, reason: 'protocol' }; }
  return { ok: true, payload };
}

// Read-only: pids with a LISTEN socket on the port. Returns
//   { ok: true, pids: number[] }   [] means provably nothing listens (free)
//   { ok: false, ... }             query/permission/protocol failure (unknown)
// A payload entry that is not a positive integer makes the whole result
// unknown — malformed pid text is never silently discarded.
export function listPortListenerPids(port) {
  if (!Number.isInteger(port)) return { ok: false, reason: 'invalid-port' };
  const query = runStructuredQuery(
    `Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq ${port} } | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique`);
  if (!query.ok) return query;
  const pids = query.payload;
  if (!Array.isArray(pids) || !pids.every((pid) => Number.isInteger(pid) && pid > 0)) {
    return { ok: false, reason: 'malformed-pids' };
  }
  return { ok: true, pids };
}

// Read-only identity lookup for one pid (structured contract):
//   { ok: true, records: [] }                     no process object — gone
//   { ok: true, records: [ { Name, CommandLine,
//     ExecutablePath, ParentProcessId, CreationDate } ] }   live (fields may be null)
//   { ok: false, ... }                            query/parse failure — OR a
//     malformed record shape (e.g. a [null] payload): explicit unknown,
//     never a crash and never a silently-dropped identity.
function queryProcessRecord(pid) {
  const query = runStructuredQuery(
    `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop | Select-Object Name,CommandLine,ExecutablePath,ParentProcessId,CreationDate`);
  if (!query.ok) return query;
  if (!Array.isArray(query.payload) || query.payload.length > 1) return { ok: false, reason: 'protocol' };
  const record = query.payload[0];
  if (record === undefined) return { ok: true, records: [] };
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return { ok: false, reason: 'protocol' };
  return { ok: true, records: [record] };
}

// Diagnostic-only image name for port reports; null when unavailable.
function queryProcessImageName(pid) {
  const query = runStructuredQuery(`[string](Get-Process -Id ${pid} -ErrorAction Stop).ProcessName`);
  if (!query.ok || !Array.isArray(query.payload) || query.payload.length !== 1) return null;
  const name = query.payload[0];
  return typeof name === 'string' && name ? name : null;
}

// ── Handle-exit oracle (batch 06 cleanup correction) ────────────────────────
// Termination is settled by a pinned process exit signal, corroborated absence,
// or proven identity replacement, never by taskkill text or WMI presence alone.

// Win32_Process CreationDate as ConvertTo-Json serializes it: "/Date(ms)/"
// with epoch milliseconds — machine-readable, locale-independent.
function parseDotNetDateMs(token) {
  if (typeof token !== 'string') return null;
  const m = /^\/Date\((-?\d+)\)\/$/.exec(token);
  return m ? Number(m[1]) : null;
}

// A bounded event-driven observation, not a success deadline. Some observed
// exits exceeded this budget; callers must retain unresolved identities.
const EXIT_SETTLE_MS = 120000;

// Failed cleanup may be retried by the restart/finally paths. Keep unresolved
// candidates for this sandbox until fresh evidence resolves them, including
// across calls. These IDs require revalidation; they never authorize a kill.
const unresolvedRuntimeCandidates = new Map();

function creationMsOf(record) {
  return parseDotNetDateMs(record?.CreationDate);
}

// Wait, READ-ONLY, for the exit signal of one exact process object. The
// PowerShell session opens the process handle itself and pins it to the
// expected creation time BEFORE waiting, so a pid reused between the
// ownership proof and this query cannot be mistaken for the owned object.
// Returns one of:
//   { ok: true, result: { outcome: 'exit-confirmed', waitedMs, exitCode } }
//   { ok: true, result: { outcome: 'exit-pending',   waitedMs } }
//   { ok: true, result: { outcome: 'pid-reuse',      observedStartMs } }
//   { ok: true, result: { outcome: 'not-found' | 'open-error', exceptionType } }
//   { ok: false, reason }  the observation itself failed → unknown, never
//                          interpreted as exit or survival
// Exception classification uses the .NET exception TYPE name only; localized
// message prose is never parsed.
function waitOwnedProcessExit({ pid, expectedStartMs, budgetMs }) {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(expectedStartMs) ||
    !Number.isInteger(budgetMs) || budgetMs < 0) return { ok: false, reason: 'invalid-args' };
  const inner = `
$proc = $null
try {
  $proc = Get-Process -Id ${pid} -ErrorAction Stop
  [void]$proc.Handle
  $startMs = ([DateTimeOffset]$proc.StartTime).ToUnixTimeMilliseconds()
  if ($startMs -ne ${expectedStartMs}) {
    [pscustomobject]@{ outcome = 'pid-reuse'; observedStartMs = $startMs }
  } else {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $signaled = $proc.WaitForExit(${budgetMs})
    $code = $null
    if ($signaled) { $oc = 'exit-confirmed'; try { $code = $proc.ExitCode } catch { $code = $null } }
    else { $oc = 'exit-pending' }
    [pscustomobject]@{ outcome = $oc; waitedMs = $sw.ElapsedMilliseconds; exitCode = $code }
  }
} catch {
  $et = $_.Exception.GetType().Name
  if ($et -eq 'ProcessCommandException') { [pscustomobject]@{ outcome = 'not-found'; exceptionType = $et } }
  else { [pscustomobject]@{ outcome = 'open-error'; exceptionType = $et } }
} finally {
  if ($null -ne $proc) { $proc.Dispose() }
}`.trim();
  const query = runStructuredQuery(inner, { timeoutMs: budgetMs + 30000 });
  if (!query.ok) return query;
  if (!Array.isArray(query.payload) || query.payload.length !== 1) return { ok: false, reason: 'protocol' };
  const result = query.payload[0];
  if (result === null || typeof result !== 'object' || typeof result.outcome !== 'string' || result.outcome === '') {
    return { ok: false, reason: 'protocol' };
  }
  return { ok: true, result };
}

// Record the ORIGINAL termination-command error (status + message) without
// interpreting it: taskkill exit codes and text are not exit evidence.
function taskkillErrorOf(error) {
  return { status: Number.isInteger(error?.status) ? error.status : null, message: String(error?.message ?? error) };
}

// Terminate WebView2 browser processes proven to belong to this run. Proof is
// two queries per pid: the enumeration surfaces candidates, then EACH pid is
// re-queried at the termination boundary and must STILL be an msedgewebview2
// whose effective --user-data-dir resolves into this run's sandbox (the
// enumeration is a snapshot; the pid may be replaced between the queries).
// Image name alone, substring coincidence, or port occupancy prove nothing.
// Every termination request is then SETTLED by the handle-exit oracle pinned
// to that same record's creation time: taskkill's own exit status is recorded
// but never interpreted (a failing taskkill against an already-terminating
// process is the observed normal case, and exit 0 alone is not exit either).
// Report shape (callers must aggregate, never assume):
//   exitConfirmed  pids whose owned-object exit was observed (wait signal,
//                  corroborated absence, proven reuse, or already gone)
//   pending        termination requested, exit NOT observed within the budget
//                  (survivor or incomplete teardown — failing, not assumed)
//   unknown        identity or exit status unreadable (uncertainty — reported,
//                  and where no ownership pin was possible, not even killed)
//   foreignNow     candidates whose fresh record no longer proves ownership
//                  (left alive; correctly NOT killed)
//   skippedUnproven msedgewebview2 records without profile evidence
//   killErrors     original per-pid termination-command errors, preserved
//   enumerationFailed  the enumeration itself failed (owned-browser state
//                  unknown — explicit uncertainty, not empty success)
export function killSandboxBrowsers(sandboxDirectory, { settleBudgetMs = EXIT_SETTLE_MS, knownCandidates = new Set(), knownStarts = new Map(), exitStates = new Map() } = {}) {
  const report = { exitConfirmed: [], pending: [], unknown: [], foreignNow: [], skippedUnproven: 0, enumerationFailed: false, killErrors: {} };
  if (!sandboxDirectory) return report;
  const enumeration = runStructuredQuery(
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction Stop | Select-Object ProcessId,CommandLine`);
  if (!enumeration.ok || !Array.isArray(enumeration.payload)) {
    report.enumerationFailed = true;
    return report;
  }
  for (const record of enumeration.payload) {
    if (record === null || typeof record !== 'object' || Array.isArray(record) ||
      !Number.isInteger(record.ProcessId) || record.ProcessId <= 0) {
      // Malformed identity in the enumeration: the sweep's view is untrustworthy.
      report.enumerationFailed = true;
      continue;
    }
    const pid = record.ProcessId;
    const commandLine = typeof record.CommandLine === 'string' ? record.CommandLine : null;
    if (sandboxProfileVerdict(commandLine, sandboxDirectory) !== 'owned') { report.skippedUnproven += 1; continue; }
    knownCandidates.add(pid);
  }
  // Enumeration is only candidate discovery. A previously unresolved PID
  // remains a candidate even if enumeration omits it or loses its command line.
  // Every kill still requires the fresh identity query below.
  const observedStarts = new Map();
  // Teardown can make WMI ownership fields unreadable before the object is
  // signaled. A previously proven creation identity can still authorize a
  // READ-ONLY pinned wait, never a new termination request.
  const observeKnownExit = (pid) => {
    const startMs = knownStarts.get(pid);
    if (!Number.isInteger(startMs)) return false;
    const wait = waitOwnedProcessExit({ pid, expectedStartMs: startMs, budgetMs: settleBudgetMs });
    if (!wait.ok) return false;
    observedStarts.set(pid, startMs);
    if (wait.result.outcome === 'exit-confirmed') { report.exitConfirmed.push(pid); return true; }
    if (wait.result.outcome === 'pid-reuse') { report.foreignNow.push(pid); return true; }
    if (wait.result.outcome === 'exit-pending') { report.pending.push(pid); return true; }
    if (wait.result.outcome === 'not-found') {
      const corroborate = queryProcessRecord(pid);
      if (corroborate.ok && corroborate.records.length === 0) { report.exitConfirmed.push(pid); return true; }
    }
    return false;
  };
  for (const pid of knownCandidates) {
    const fresh = queryProcessRecord(pid);
    if (!fresh.ok) { if (!observeKnownExit(pid)) report.unknown.push(pid); continue; }
    if (fresh.records.length === 0) { report.exitConfirmed.push(pid); continue; } // already gone: nothing to kill
    const record2 = fresh.records[0];
    const observedStart = creationMsOf(record2);
    if (Number.isInteger(observedStart)) observedStarts.set(pid, observedStart);
    if (typeof record2.Name !== 'string' || record2.Name === '') {
      // Identity unreadable at the boundary: uncertainty, not a kill and not
      // a foreign classification.
      if (!observeKnownExit(pid)) report.unknown.push(pid);
      continue;
    }
    if (record2.Name.toLowerCase() !== 'msedgewebview2.exe') {
      // The pid now hosts a different image: the original browser is gone
      // (reuse) — nothing of ours to kill, recorded for reporting.
      report.foreignNow.push(pid);
      continue;
    }
    const profile = sandboxProfileVerdict(record2.CommandLine, sandboxDirectory);
    if (profile === 'unknown') { if (!observeKnownExit(pid)) report.unknown.push(pid); continue; }
    if (profile === 'foreign') { report.foreignNow.push(pid); continue; } // positively a different browser
    // Pin for the settle: without a creation time the wait cannot defend
    // against pid reuse, so the pid is not terminated at all (fail closed).
    const startMs = creationMsOf(record2);
    if (!Number.isInteger(startMs)) { if (!observeKnownExit(pid)) report.unknown.push(pid); continue; }
    knownStarts.set(pid, startMs);
    // Termination request. The original command error is preserved verbatim
    // and NEVER interpreted as exit/survival evidence.
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'pipe', windowsHide: true });
    } catch (e) { report.killErrors[pid] = taskkillErrorOf(e); }
    // Settle the outcome on the exact owned object.
    const wait = waitOwnedProcessExit({ pid, expectedStartMs: startMs, budgetMs: settleBudgetMs });
    if (!wait.ok) { report.unknown.push(pid); continue; }
    if (wait.result.outcome === 'exit-confirmed') { report.exitConfirmed.push(pid); continue; }
    if (wait.result.outcome === 'pid-reuse') { report.foreignNow.push(pid); continue; } // original gone; occupant not ours
    if (wait.result.outcome === 'exit-pending') { report.pending.push(pid); continue; }
    if (wait.result.outcome === 'not-found') {
      // Handle open says no object; the record existed moments ago. Corrobor
      // with a fresh listing before concluding anything: agreement on absence
      // is exit evidence, disagreement is honest unknown.
      const corroborate = queryProcessRecord(pid);
      if (corroborate.ok && corroborate.records.length === 0) report.exitConfirmed.push(pid);
      else report.unknown.push(pid);
      continue;
    }
    report.unknown.push(pid); // open-error and anything malformed
  }
  for (const [state, pids] of [['exit-confirmed', report.exitConfirmed], ['exit-pending', report.pending], ['unknown', report.unknown]]) {
    for (const pid of pids) {
      const startMs = observedStarts.get(pid);
      if (Number.isInteger(startMs)) exitStates.set(pid, { startMs, state });
    }
  }
  for (const pid of [...report.exitConfirmed, ...report.foreignNow]) {
    knownCandidates.delete(pid);
    knownStarts.delete(pid);
  }
  return report;
}

// READ-ONLY classification of what still holds a port AFTER this run's owned
// cleanup ran. Nothing is ever terminated here; callers turn non-clean
// findings into an explicit incomplete-cleanup condition. Classification uses
// a FRESH query — a port that was free (or ours) at startup does not stay
// ours for the whole run, so no earlier snapshot may vote.
//   free        nothing listens (successful empty result)
//   unknown     the listener query failed (never the same as free)
//   gone        socket outlived its process — nothing left to prove or kill.
//               This includes an OWNED browser whose exit was handle-confirmed
//               while the LISTEN socket lingers: kernel socket teardown is
//               release evidence, not liveness, and relaunches use fresh
//               ports anyway. Process exit and actual port release stay
//               separate checks — exit is confirmed by handle, the socket by
//               this query; neither implies the other.
//   owned-browser  live msedgewebview2 whose effective profile is this run's
//                  sandbox AND whose exit is not confirmed (it observably
//                  survived the sweep — cleanup incomplete)
//   foreign     live process not provably ours (holder replacement / pid
//               reuse) — left alive and reported
// options.exitStates maps PID to { startMs, state }. Reuse is permitted only
// when the fresh creation identity matches, even within the same sweep round.
export function auditPortListeners(port, sandboxDirectory, { exitStates, settleBudgetMs = EXIT_SETTLE_MS } = {}) {
  const listeners = listPortListenerPids(port);
  if (!listeners.ok) return { state: 'unknown' };
  if (listeners.pids.length === 0) return { state: 'free' };
  const findings = [];
  for (const pid of listeners.pids) {
    const query = queryProcessRecord(pid);
    if (!query.ok) { findings.push({ pid, class: 'unknown' }); continue; }
    if (query.records.length === 0) { findings.push({ pid, class: 'gone' }); continue; }
    const record = query.records[0];
    // Browser identity must be POSITIVELY established: a missing name is an
    // unknown finding, never a bypass of the kind check.
    if (typeof record.Name !== 'string' || record.Name === '') { findings.push({ pid, class: 'unknown' }); continue; }
    if (record.Name.toLowerCase() !== 'msedgewebview2.exe') { findings.push({ pid, class: 'foreign', name: record.Name }); continue; }
    const profile = sandboxProfileVerdict(record.CommandLine, sandboxDirectory);
    if (profile !== 'owned') {
      if (profile === 'foreign') findings.push({ pid, class: 'foreign', name: record.Name });
      else findings.push({ pid, class: 'unknown' });
      continue;
    }
    // Owned browser on the port: is its OBJECT exited? Fresh sweep evidence
    // first, otherwise settle through the oracle pinned to this record.
    // (Duck-typed on purpose: the caller's Map may come from another realm
    // in the VM test harness, where instanceof would falsely fail.)
    const startMs = creationMsOf(record);
    if (!Number.isInteger(startMs)) { findings.push({ pid, class: 'unknown' }); continue; }
    const cached = exitStates != null && typeof exitStates.get === 'function' ? exitStates.get(pid) : undefined;
    const settled = cached?.startMs === startMs ? cached.state : undefined;
    if (settled === 'exit-confirmed') { findings.push({ pid, class: 'gone', exitConfirmed: true }); continue; }
    if (settled === 'exit-pending') { findings.push({ pid, class: 'owned-browser', name: record.Name }); continue; }
    if (settled === 'unknown') { findings.push({ pid, class: 'unknown' }); continue; }
    const wait = waitOwnedProcessExit({ pid, expectedStartMs: startMs, budgetMs: settleBudgetMs });
    if (!wait.ok) { findings.push({ pid, class: 'unknown' }); continue; }
    if (wait.result.outcome === 'exit-confirmed') { findings.push({ pid, class: 'gone', exitConfirmed: true }); continue; }
    if (wait.result.outcome === 'pid-reuse') { findings.push({ pid, class: 'gone', exitConfirmed: true }); continue; } // original gone; socket lingers
    if (wait.result.outcome === 'not-found') {
      const corroborate = queryProcessRecord(pid);
      if (corroborate.ok && corroborate.records.length === 0) findings.push({ pid, class: 'gone', exitConfirmed: true });
      else findings.push({ pid, class: 'unknown' });
      continue;
    }
    if (wait.result.outcome === 'exit-pending') { findings.push({ pid, class: 'owned-browser', name: record.Name }); continue; }
    findings.push({ pid, class: 'unknown' }); // open-error and anything malformed
  }
  return { state: 'held', findings };
}

// Terminate the owned host child. Kills happen ONLY behind fresh identity
// proof; a failed or UNREADABLE identity query re-queries (bounded) and
// otherwise leaves the process alive — an existence check NEVER authorizes a
// kill, and transport success is never mistaken for identity certainty.
// Each termination request is settled by the handle-exit oracle pinned to
// the identity record's creation time; "killed" means the exit signal of the
// exact object was observed, the record is gone, or it shows a VALID
// different executable (proven reuse — taskkill exit status alone proves
// nothing either way). A record whose executable is null/unreadable is
// 'unknown' — incomplete cleanup with the live handle retained. Still
// provably ours and not exited after a settle = ONE more verified attempt,
// then failure. Dispositions: dead | killed | mismatch | unknown | failed.
function killOwnedHostChild(child, executable, { settleBudgetMs = EXIT_SETTLE_MS } = {}) {
  let ownershipProven = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const identity = queryProcessRecord(child.pid);
    if (!identity.ok) continue; // transient query failure: re-query, never kill
    if (identity.records.length === 0) return { disposition: 'dead', reasons: [] };
    const initial = executableVerdict(identity.records[0], executable);
    if (initial === 'unknown') continue; // unreadable identity: re-query, never kill
    if (initial === 'foreign') {
      return { disposition: 'mismatch',
        reasons: [`host pid ${child.pid} no longer runs the sandbox executable (pid reuse/metadata change) — left alive`] };
    }
    // Fresh executable evidence authorizes the request; the creation pin
    // additionally binds the subsequent exit observation to this identity.
    ownershipProven = true;
    const startMs = creationMsOf(identity.records[0]);
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'pipe', windowsHide: true });
    } catch { /* the settle below is the evidence, not this command's status */ }
    if (Number.isInteger(startMs)) {
      const wait = waitOwnedProcessExit({ pid: child.pid, expectedStartMs: startMs, budgetMs: settleBudgetMs });
      if (wait.ok && wait.result.outcome === 'exit-confirmed') return { disposition: 'killed', reasons: [] };
      if (wait.ok && wait.result.outcome === 'pid-reuse') return { disposition: 'killed', reasons: [] }; // original gone
    }
    // Oracle unavailable, unpinned, not-found or still pending: settle on
    // fresh identity evidence (record gone = killed; a VALID different
    // executable = proven reuse = killed; unreadable = unknown).
    const verify = queryProcessRecord(child.pid);
    if (!verify.ok) return { disposition: 'unknown', reasons: [`host pid ${child.pid}: post-termination identity query failed — termination unverified`] };
    if (verify.records.length === 0) return { disposition: 'killed', reasons: [] };
    const after = executableVerdict(verify.records[0], executable);
    if (after === 'foreign') return { disposition: 'killed', reasons: [] }; // proven reuse: the original is gone
    if (after === 'unknown') {
      return { disposition: 'unknown', reasons: [`host pid ${child.pid}: post-termination executable identity unreadable — termination unverified`] };
    }
    // Still provably ours and not observed to exit: one more VERIFIED
    // termination attempt (attempt 1 re-proves identity at the loop top).
  }
  return ownershipProven
    ? { disposition: 'failed', reasons: [`host pid ${child.pid} survived verified termination attempts — exit not observed`] }
    : { disposition: 'unknown', reasons: [`host pid ${child.pid}: identity unreadable — ownership unverifiable, left alive`] };
}

// Orchestrates the FULL owned-runtime cleanup (this is the real killExisting
// logic, exported so the actual decision path is testable with a mocked OS
// boundary): host child, sandbox browsers (with per-PID revalidation), and a
// read-only post-cleanup audit of the launch port. FINAL per-identity
// outcomes are computed from the LAST round's fresh evidence only — a failure
// observed in an earlier round is retracted by a later round that proves the
// pid exited or gone, and an unresolved pid never silently disappears. A
// browser whose exit was never observed counts even when the debug port is
// free (a free port is not proof of complete owned cleanup), enumeration
// failures count as explicit uncertainty, and foreign or unreadable port
// holders are reported and left alive. Sockets that outlive a handle-confirmed
// exit are resource-release residue, not survivors (relaunches use fresh
// ports anyway). Returns exactly true when cleanup is established, else
// { ok: false, reasons, hostDisposition } — restarts and the final run gate
// treat that as a failure.
export function killOwnedRuntime({ child, executable, sandboxDirectory, launchPort, launched }) {
  const reasons = [];
  let hostDisposition = 'dead';
  const hasLiveHandle = child && Number.isInteger(child.pid) && child.pid > 0 &&
    child.exitCode === null && child.signalCode == null;
  if (hasLiveHandle) {
    const host = killOwnedHostChild(child, executable);
    hostDisposition = host.disposition;
    reasons.push(...host.reasons);
  }
  // Browsers: bounded rounds. A browser proven ours whose exit is not yet
  // observed is re-swept next round (each round re-proves per PID with fresh
  // queries and re-settles through the oracle) — whether or not it still
  // listens: the LISTEN socket can release during kernel teardown while the
  // process object is not yet signaled (observed natively: exp6, where the
  // audit went free while the browser exited right after the settle budget;
  // the immediate fresh-evidence retry settled it in ~2 s). The final verdict
  // derives ONLY from the last round's report and audit.
  let finalReport = null;
  let finalAudit = null;
  let ownedListeningFinal = false;
  const candidateKey = normalizedPath(sandboxDirectory);
  const retained = unresolvedRuntimeCandidates.get(candidateKey) ?? { candidates: new Set(), starts: new Map() };
  const knownCandidates = retained.candidates;
  if (candidateKey) unresolvedRuntimeCandidates.set(candidateKey, retained);
  for (let round = 0; round < 3; round++) {
    const exitStates = new Map();
    const report = killSandboxBrowsers(sandboxDirectory, { knownCandidates, knownStarts: retained.starts, exitStates });
    finalReport = report;
    finalAudit = null;
    ownedListeningFinal = false;
    if (!launched || !Number.isInteger(launchPort)) break;
    const audit = auditPortListeners(launchPort, sandboxDirectory, { exitStates });
    finalAudit = audit;
    if (audit.state === 'unknown') break;
    let ownedListening = false;
    for (const finding of audit.state === 'held' ? audit.findings : []) {
      if (finding.class === 'gone') continue;
      if (finding.class === 'owned-browser') { ownedListening = true; continue; }
    }
    ownedListeningFinal = ownedListening;
    const pendingWork = report.pending.length > 0 || report.unknown.length > 0;
    if ((!ownedListening && !pendingWork) || round === 2) break;
  }
  // Final per-identity outcomes from the LAST round's fresh evidence.
  if (finalReport?.enumerationFailed) {
    reasons.push('sandbox browser enumeration failed — owned browser cleanup unverifiable');
  }
  for (const pid of finalReport?.pending ?? []) {
    const killError = finalReport?.killErrors?.[pid];
    const detail = killError && Number.isInteger(killError.status) ? ` (taskkill status ${killError.status})` : '';
    reasons.push(`sandbox browser pid ${pid} survived verified termination — exit not observed${detail}`);
  }
  for (const pid of finalReport?.unknown ?? []) {
    reasons.push(`sandbox browser pid ${pid} could not be re-verified (identity or exit status unreadable) — outcome uncertain`);
  }
  if (finalAudit) {
    if (finalAudit.state === 'unknown') {
      reasons.push(`debug port ${launchPort}: listener query failed — cleanup not verifiable`);
    } else if (finalAudit.state === 'held') {
      for (const finding of finalAudit.findings) {
        if (finding.class === 'gone') continue; // release residue, not a survivor
        if (finding.class === 'owned-browser') continue; // covered by the still-listens line below when final
        if (finding.class === 'unknown') {
          reasons.push(`debug port ${launchPort}: pid ${finding.pid} metadata unreadable — not provably ours, left alive`);
        } else {
          const who = finding.name ? `${finding.name} (pid ${finding.pid})` : `pid ${finding.pid}`;
          reasons.push(`debug port ${launchPort} still held by ${who}; not proven owned by this run — left alive`);
        }
      }
      if (ownedListeningFinal) {
        reasons.push(`debug port ${launchPort}: this run's sandbox browser still listens after repeated verified sweeps`);
      }
    }
  }
  if (candidateKey && knownCandidates.size === 0) unresolvedRuntimeCandidates.delete(candidateKey);
  if (reasons.length > 0) return { ok: false, reasons: [...new Set(reasons)], hostDisposition };
  return true;
}

// Prove the CDP endpoint belongs to THIS run before any attach/evaluate:
// the debug-port listener must be a live msedgewebview2 whose parent chain
// reaches the host pid, and that host pid must STILL run the sandbox
// executable (fresh metadata, not a launch-time snapshot). Returns true or
// { ok: false, reasons } — callers refuse to attach on anything but true.
export function verifyCdpEndpointOwnership(port, child, executable) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0 ||
    child.exitCode !== null || child.signalCode != null) {
    return { ok: false, reasons: ['no live owned host process handle'] };
  }
  const listeners = listPortListenerPids(port);
  if (!listeners.ok) return { ok: false, reasons: [`debug port ${port}: listener query failed — endpoint identity unverifiable`] };
  if (listeners.pids.length === 0) return { ok: false, reasons: [`debug port ${port}: no listener (endpoint gone)`] };
  const host = queryProcessRecord(child.pid);
  if (!host.ok) return { ok: false, reasons: [`host pid ${child.pid}: identity query failed — endpoint ownership unverifiable`] };
  if (host.records.length === 0) return { ok: false, reasons: [`host pid ${child.pid} is gone`] };
  const hostVerdict = executableVerdict(host.records[0], executable);
  if (hostVerdict === 'foreign') {
    return { ok: false, reasons: [`host pid ${child.pid} no longer runs the sandbox executable — endpoint not proven ours`] };
  }
  if (hostVerdict === 'unknown') {
    return { ok: false, reasons: [`host pid ${child.pid}: executable identity unreadable — endpoint ownership unproven`] };
  }
  const reasons = [];
  for (const pid of listeners.pids) {
    const hop = listenerReachesHost(pid, child.pid, 0);
    if (hop !== true) reasons.push(`debug port ${port} listener ${typeof hop === 'string' ? hop : `pid ${pid}: not proven part of the owned browser tree`}`);
  }
  return reasons.length > 0 ? { ok: false, reasons } : true;
}

// Walk a bounded parent chain: every hop must be POSITIVELY identified as a
// live msedgewebview2 (a missing name is unreadable, not a pass) until the
// host pid is reached. Returns true or a human-readable failure reason.
function listenerReachesHost(pid, hostPid, depth) {
  if (pid === hostPid) return true;
  if (depth >= 5) return `pid ${pid}: parent chain does not reach the host within bounds`;
  const query = queryProcessRecord(pid);
  if (!query.ok) return `pid ${pid}: identity query failed`;
  if (query.records.length === 0) return `pid ${pid}: no live process record`;
  const record = query.records[0];
  if (typeof record.Name !== 'string' || record.Name === '') return `pid ${pid}: browser identity unreadable`;
  if (record.Name.toLowerCase() !== 'msedgewebview2.exe') {
    return `pid ${pid}: listener is ${record.Name}, not msedgewebview2`;
  }
  if (!Number.isInteger(record.ParentProcessId) || record.ParentProcessId <= 0) return `pid ${pid}: no parent metadata`;
  return listenerReachesHost(record.ParentProcessId, hostPid, depth + 1);
}

// Gate between endpoint discovery and CDP attachment. Two independent proofs
// are required, in order:
//   1. DESTINATION BINDING: the discovered ws URL must point at the expected
//      loopback target (ws(s) scheme, 127.0.0.1/localhost host, the exact
//      expected port, a /devtools/page/ target) — otherwise the ownership
//      proof could approve a connection to a DIFFERENT endpoint than the one
//      discovery returned.
//   2. OWNERSHIP: verify(port) — verifyCdpEndpointOwnership for that SAME
//      port — must return exactly true.
// Discovery itself (fetching /json) is harmless, but attach+evaluate can
// interfere with whoever REALLY owns an endpoint (Runtime.evaluate vs real
// SSH sessions is a recorded failure class). Any failure throws BEFORE the
// caller can construct a CDP session — zero CDP actions on an unowned,
// replaced or mismatched endpoint.
export async function acquireVerifiedPage({ discover, expectedPort, verify }) {
  const wsUrl = await discover();
  if (typeof wsUrl !== 'string' || wsUrl === '') {
    throw new Error(`refusing CDP attach: discovery returned no endpoint (${String(wsUrl)})`);
  }
  let parsed;
  try { parsed = new URL(wsUrl); } catch { throw new Error(`refusing CDP attach: discovered endpoint is not a URL: ${wsUrl}`); }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`refusing CDP attach: endpoint scheme ${parsed.protocol} is not a devtools WebSocket`);
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  const port = Number.parseInt(parsed.port, 10);
  if (!loopback || !Number.isInteger(port) || port !== expectedPort) {
    throw new Error(`refusing CDP attach: endpoint ${wsUrl} does not match the expected loopback target 127.0.0.1:${expectedPort}`);
  }
  if (!parsed.pathname.startsWith('/devtools/page/')) {
    throw new Error(`refusing CDP attach: endpoint path ${parsed.pathname} is not a devtools page target`);
  }
  let verdict;
  try { verdict = await verify(port); }
  catch (error) { verdict = { ok: false, reasons: [`endpoint verification error: ${error?.message ?? error}`] }; }
  if (verdict !== true) {
    const detail = verdict && Array.isArray(verdict.reasons) ? verdict.reasons.join('; ') : 'ownership not proven';
    throw new Error(`refusing CDP attach: ${detail}`);
  }
  return wsUrl;
}

export async function restartOwnedApp({ stop, waitUntilQuiet, start }) {
  // stop must return exactly true: a hard failure AND an incomplete-cleanup
  // report object both refuse the restart — an uncertain cleanup is never
  // treated as established.
  if (stop() !== true) throw new Error('Owned process cleanup was not established; refusing restart');
  await waitUntilQuiet();
  return start();
}

// READ-ONLY startup discovery for the per-launch debug port range. Per-launch
// ports isolate launches WITHIN one run, but a listener from OUTSIDE this run
// (a previous run's orphaned browser, or the user's own ZTerm/WebView2) can
// squat on one — observed: /json answered yet never listed the renderer page.
// Holders are never killed here (rule 1): an image name is recorded for
// diagnostics only. Returns one entry per non-free port, so the caller can
// shift the base port while anything stays occupied or unqueryable:
//   { port, holders: [{ pid, name }], unknown }   unknown=true → query failed.
export function probeDebugPortRange(base, count) {
  const occupied = [];
  for (let port = base; port < base + count; port++) {
    const listeners = listPortListenerPids(port);
    if (!listeners.ok) { occupied.push({ port, holders: [], unknown: true }); continue; }
    if (listeners.pids.length === 0) continue;
    occupied.push({ port, holders: listeners.pids.map((pid) => ({ pid, name: queryProcessImageName(pid) })), unknown: false });
  }
  return occupied;
}
