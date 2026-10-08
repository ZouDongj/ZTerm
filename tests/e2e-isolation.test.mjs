import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
// Namespace import on purpose: tests assert per-function behavior (and the
// ABSENCE of the removed blind-termination exports); a named import would
// fail the whole file at link time instead.
import * as isolation from '../scripts/e2e-isolation.mjs';
import { loadIsolationModule, fakeExec, okEnvelope, errEnvelope } from './helpers/isolation-vm.mjs';

const { createE2eSandbox, ownsProcess, ownsSandboxProfile, sandboxProfileVerdict, restartOwnedApp, seedIsolatedConfig,
  probeDebugPortRange, killSandboxBrowsers, auditPortListeners, killOwnedRuntime,
  verifyCdpEndpointOwnership, acquireVerifiedPage, listPortListenerPids } = isolation;

// Scratch policy: every temp path this file creates lives under the repo's
// E2E_TMP_ROOT and is registered for exit cleanup (root AGENTS rule; never
// os.tmpdir, never %TEMP%). The root is cleaned after each run, so recreate
// it before mkdtemp — mkdtempSync does not create missing parents.
const freshScratch = (name) => {
  mkdirSync(isolation.E2E_TMP_ROOT, { recursive: true });
  return isolation.registerExitCleanup(mkdtempSync(join(isolation.E2E_TMP_ROOT, name)));
};

// VM results come from another realm: normalize through JSON before comparing
// with strict deepEqual (which would otherwise reject on prototype identity).
const plain = (value) => JSON.parse(JSON.stringify(value));

// ── shared fixtures ─────────────────────────────────────────────────────────
const SBX = 'D:\\repo\\artifacts\\e2e-tmp\\zterm-e2e-ab12cd34';
const HOST_EXE = `${SBX}\\zterm.exe`;
const hostChild = (pid) => ({ pid, exitCode: null, signalCode: null });
// Win32_Process CreationDate as ConvertTo-Json serializes it (machine-readable
// epoch ms — validated by the batch06 api-contract probe). Browsers start a
// little after the host, like the real launch.
const T0 = 1790581112814;
const dateToken = (ms) => `/Date(${ms})/`;
const hostRecord = (pid, exe = HOST_EXE) =>
  okEnvelope([{ ProcessId: pid, Name: 'zterm.exe', CommandLine: `"${exe}"`, ExecutablePath: exe, ParentProcessId: 4, CreationDate: dateToken(T0 - 5000) }]);
// Route output for a host that dies on its first verified kill: the identity
// query sees the live record, every later (post-termination) query sees it gone.
const dyingHostRecord = () => { let queries = 0; return () => (queries++ === 0 ? hostRecord(555) : goneRecord()); };
const goneRecord = () => okEnvelope([]);
// Browser command lines carry the executable as argv0 before any switch
// (round 3: argv0 is never a switch, so fixtures must be shaped like real
// Win32_Process CommandLine values).
const WV_ARGV0 = '"C:\\Program Files\\WebView2\\msedgewebview2.exe"';
const wvLine = (udf) => `${WV_ARGV0} --user-data-dir=${udf}`;
const browserRecord = (pid, udf, extra = {}) =>
  okEnvelope([{ ProcessId: pid, Name: 'msedgewebview2.exe', CommandLine: wvLine(udf), ParentProcessId: 555, CreationDate: dateToken(T0), ...extra }]);
// Handle-exit oracle envelopes (structured /Get-Process -Id <pid>/ wait query).
const waitOk = (fields) => okEnvelope([fields]);
const WAIT_EXIT = waitOk({ outcome: 'exit-confirmed', waitedMs: 12, exitCode: 1 });
const WAIT_PENDING = waitOk({ outcome: 'exit-pending', waitedMs: 1000, exitCode: null });
const WAIT_REUSE = waitOk({ outcome: 'pid-reuse', observedStartMs: T0 + 600000 });
const WAIT_NOT_FOUND = waitOk({ outcome: 'not-found', exceptionType: 'ProcessCommandException' });
const WAIT_OPEN_ERROR = waitOk({ outcome: 'open-error', exceptionType: 'Win32Exception' });
// Route matcher for the wait query of one pid (script embeds "Get-Process -Id
// <pid> -ErrorAction Stop"; distinct from the WMI /ProcessId=<pid>/ queries).
const waitQuery = (pid) => new RegExp(`Get-Process -Id ${pid}\\b`);

test('E2E copies only the executable into a fresh profile, leaving source config intact', () => {
  const root = freshScratch('isolation-test-');
  const source = join(root, 'source');
  mkdirSync(join(source, 'data'), { recursive: true });
  writeFileSync(join(source, 'zterm.exe'), 'test executable');
  writeFileSync(join(source, 'data', 'config.json'), 'user config sentinel');
  const box = createE2eSandbox(join(source, 'zterm.exe'), root);
  assert.ok(box.directory.startsWith(isolation.E2E_TMP_ROOT), 'sandbox stays inside the repo scratch root');
  assert.equal(readFileSync(box.exe, 'utf8'), 'test executable');
  assert.equal(existsSync(join(box.directory, 'data', 'config.json')), false);
  assert.equal(existsSync(join(box.appData, 'ZTerm', 'config.json')), false);
  assert.equal(readFileSync(join(source, 'data', 'config.json'), 'utf8'), 'user config sentinel');
});

test('cleanup requires live owned PID and exact sandbox executable identity', () => {
  const executable = join(isolation.E2E_TMP_ROOT, 'owned-zterm', 'zterm.exe');
  const child = { pid: 123, exitCode: null, signalCode: null };
  const actual = { ProcessId: 123, ExecutablePath: executable };
  assert.equal(ownsProcess(child, executable, actual), true);
  assert.equal(ownsProcess(null, executable, actual), false);
  assert.equal(ownsProcess(child, executable, null), false);
  assert.equal(ownsProcess(child, executable, { ...actual, ProcessId: 999 }), false);
  // A foreign zterm.exe with the same image name but a different path is NOT ours.
  assert.equal(ownsProcess(child, executable, { ...actual, ExecutablePath: join(isolation.E2E_TMP_ROOT, 'user', 'zterm.exe') }), false);
  // Malformed metadata (non-string path) must never pass as ownership.
  assert.equal(ownsProcess(child, executable, { ...actual, ExecutablePath: 42 }), false);
  assert.equal(ownsProcess({ ...child, exitCode: 0 }, executable, actual), false);
});

test('ownsSandboxProfile accepts only a real, unambiguous --user-data-dir switch', () => {
  const line = (udf) => `"C:\\Program Files (x86)\\Webview\\msedgewebview2.exe" --embedded-browser-webview-enabled=1 --user-data-dir=${udf} --no-first-run`;
  // Owned: exact switch token, quoted/bare value, case, trailing separator,
  // forward slashes, dot segments, duplicate identical switches.
  assert.equal(ownsSandboxProfile(line(`"${SBX}\\webview-1"`), SBX), true, 'quoted child profile');
  assert.equal(ownsSandboxProfile(line(SBX), SBX), true, 'exact dir');
  assert.equal(ownsSandboxProfile(line(`${SBX}\\`), SBX), true, 'trailing separator');
  assert.equal(ownsSandboxProfile(line(`${SBX.toUpperCase()}\\WebView-1`), SBX), true, 'case-insensitive');
  assert.equal(ownsSandboxProfile(line('d:/repo/artifacts/e2e-tmp/zterm-e2e-ab12cd34/webview-2'), SBX), true, 'forward slashes');
  assert.equal(ownsSandboxProfile(line(`${SBX}\\webview-1\\.\\`), SBX), true, 'dot segments resolve');
  assert.equal(ownsSandboxProfile(`--user-data-dir=${SBX}\\w1 --user-data-dir=${SBX}\\w1`, SBX), true, 'duplicate identical switches');
  // A marker inside ANOTHER argument's value is not a profile switch.
  assert.equal(ownsSandboxProfile(`--note="--user-data-dir=${SBX}\\webview-1"`, SBX), false, 'marker inside --note=');
  assert.equal(ownsSandboxProfile(`--user-data-folder=${SBX}\\webview-1`, SBX), false, 'unsupported spelling is not evidence');
  // Conflicting switches are ambiguous evidence — never a convenient match.
  assert.equal(ownsSandboxProfile(line(SBX) + ' --user-data-dir=C:\\Users\\u\\WB2', SBX), false, 'owned then foreign');
  // (A switch BEFORE the executable is argv0, not a switch — see the argv0
  // cases below — so the conflict must place both switches after the exe.)
  assert.equal(ownsSandboxProfile('msedgewebview2.exe --user-data-dir=C:\\Users\\u\\WB2 ' + line(SBX), SBX), false, 'foreign then owned');
  // Foreign values and boundary violations.
  assert.equal(ownsSandboxProfile(line('C:\\Users\\u\\AppData\\Local\\ZTerm\\WebView2'), SBX), false, 'user profile');
  assert.equal(ownsSandboxProfile(line(`${SBX}DEF\\webview-1`), SBX), false, 'prefix collision without separator');
  assert.equal(ownsSandboxProfile(line(`${SBX}-tails\\webview-1`), SBX), false, 'sibling with suffix');
  assert.equal(ownsSandboxProfile(`--app-path=${SBX}\\zterm.exe`, SBX), false, 'sandbox path in unrelated arg');
  assert.equal(ownsSandboxProfile('"msedgewebview2.exe" --no-first-run', SBX), false, 'no profile switch');
  // Malformed evidence.
  assert.equal(ownsSandboxProfile(null, SBX), false, 'null command line');
  assert.equal(ownsSandboxProfile(`--user-data-dir="${SBX}`, SBX), false, 'unterminated quote');
  assert.equal(ownsSandboxProfile(line(SBX), ''), false, 'no sandbox dir given');
  // Only EFFECTIVE switches count (round 3): argv0 is never a switch, args
  // after -- are positional, and a later bare switch overrides the value.
  assert.equal(ownsSandboxProfile(`--user-data-dir=${SBX}\\webview-1`, SBX), false, 'argv0 itself is not a switch');
  assert.equal(ownsSandboxProfile(`msedgewebview2.exe -- --user-data-dir=${SBX}\\webview-1`, SBX), false, 'after -- terminator');
  assert.equal(ownsSandboxProfile(line(SBX) + ' --user-data-dir', SBX), false, 'later bare switch overrides the value');
  // A positive profile BEFORE -- stays valid even when later positional data
  // resembles another switch.
  assert.equal(ownsSandboxProfile(line(SBX) + ` -- --user-data-dir=C:\\Users\\u\\WB2`, SBX), true, 'owned switch before --');
  // Consecutive quotes are an escaped literal quote (Windows argv evidence):
  // the parsed value keeps the quote character and must not normalize into
  // the sandbox path. (Bare argv0 form `--user-data-dir=...` is separately
  // rejected above as "argv0 is not a switch".)
  assert.equal(ownsSandboxProfile(`msedgewebview2.exe --user-data-dir="${SBX}""\\webview-1"`, SBX), false, 'consecutive quotes keep the literal quote');
});

test('sandboxProfileVerdict separates owned / positively foreign / unknown', () => {
  const line = (udf) => `msedgewebview2.exe --user-data-dir=${udf}`;
  // Positively foreign: a valid effective profile that resolves elsewhere.
  assert.equal(sandboxProfileVerdict(line('C:\\Users\\u\\WB2'), SBX), 'foreign');
  // Unknown: absent/malformed/ambiguous evidence — never "foreign" and never owned.
  assert.equal(sandboxProfileVerdict(null, SBX), 'unknown', 'no command line');
  assert.equal(sandboxProfileVerdict('msedgewebview2.exe --no-first-run', SBX), 'unknown', 'no profile switch');
  assert.equal(sandboxProfileVerdict(line(SBX) + ' --user-data-dir=C:\\Users\\u\\WB2', SBX), 'unknown', 'conflicting switches');
  assert.equal(sandboxProfileVerdict(line(SBX) + ' --user-data-dir', SBX), 'unknown', 'later bare switch');
  assert.equal(sandboxProfileVerdict(line('relative\\path'), SBX), 'unknown', 'relative value');
  assert.equal(sandboxProfileVerdict('msedgewebview2.exe --user-data-dir="' + SBX + '""\\webview-1"', SBX), 'unknown', 'literal quote is not a valid foreign profile');
  assert.equal(sandboxProfileVerdict(`msedgewebview2.exe -- --user-data-dir=${SBX}`, SBX), 'unknown', 'after -- terminator');
  assert.equal(sandboxProfileVerdict(`--user-data-dir=${SBX}`, SBX), 'unknown', 'argv0 is not a switch');
  assert.equal(sandboxProfileVerdict(`--user-data-dir="${SBX}`, SBX), 'unknown', 'unterminated quote');
  // Owned.
  assert.equal(sandboxProfileVerdict(line(`"${SBX}\\webview-1"`), SBX), 'owned');
});

test('listPortListenerPids distinguishes successful-empty from every failure', () => {
  const run = (output) => {
    const exec = fakeExec({ queries: [{ match: /LocalPort -eq 9222/, output }] });
    return { result: plain(loadIsolationModule({ exec }).listPortListenerPids(9222)), kills: exec.kills };
  };
  assert.deepEqual(run(okEnvelope([314159])).result, { ok: true, pids: [314159] });
  assert.deepEqual(run(okEnvelope([])).result, { ok: true, pids: [] }, 'successful empty means free, not unknown');
  // Access-denied style terminating error → unknown, never free.
  assert.equal(run(errEnvelope('Access is denied')).result.ok, false, 'query error is unknown');
  // powershell itself failing to run → unknown.
  assert.equal(run({ throw: 'spawn failed' }).result.ok, false, 'unavailable is unknown');
  // Garbage without a protocol marker → unknown.
  assert.equal(run('no marker at all').result.ok, false, 'protocol garbage is unknown');
  // Malformed pid text is unknown, not silently discarded.
  assert.equal(run(okEnvelope([314159, 'x'])).result.ok, false, 'malformed pid entry is unknown');
});

test('startup port discovery is read-only: foreign holders are reported, never killed', () => {
  const cases = [
    { name: 'foreign same-name ZTerm', pid: 314159, image: 'zterm' },
    { name: 'foreign WebView2', pid: 271828, image: 'msedgewebview2' },
    { name: 'foreign other process', pid: 141421, image: 'node' },
  ];
  for (const { name, pid, image } of cases) {
    const exec = fakeExec({ queries: [
      { match: /LocalPort -eq 9222/, output: okEnvelope([pid]) },
      { match: new RegExp(`Get-Process -Id ${pid} `), output: okEnvelope([image]) },
    ] });
    const api = loadIsolationModule({ exec });
    const occupied = plain(api.probeDebugPortRange(9222, 1));
    assert.deepEqual(occupied, [{ port: 9222, holders: [{ pid, name: image }], unknown: false }], name);
    assert.deepEqual(exec.kills, [], `${name}: no termination`);
  }
  // Listener query fails → unknown, reported occupied, still no kill.
  {
    const exec = fakeExec({ queries: [{ match: /LocalPort -eq 9222/, output: errEnvelope('denied') }] });
    const api = loadIsolationModule({ exec });
    assert.deepEqual(plain(api.probeDebugPortRange(9222, 1)), [{ port: 9222, holders: [], unknown: true }]);
    assert.deepEqual(exec.kills, []);
  }
  // Free port (successful empty envelope) → not occupied.
  {
    const exec = fakeExec({ queries: [{ match: /LocalPort -eq 9222/, output: okEnvelope([]) }] });
    const api = loadIsolationModule({ exec });
    assert.deepEqual(plain(api.probeDebugPortRange(9222, 1)), []);
  }
});

test('killSandboxBrowsers revalidates each PID at the termination boundary', () => {
  const UDF = `${SBX}\\webview-1`;
  const enumWith = (udf) => okEnvelope([{ ProcessId: 101, CommandLine: wvLine(udf) }]);
  const run = (routes) => {
    const exec = fakeExec({ queries: routes });
    const api = loadIsolationModule({ exec });
    return { report: plain(api.killSandboxBrowsers(SBX)), kills: exec.kills };
  };
  // Confirmed owned: enumeration + fresh per-PID recheck both prove the profile,
  // and the handle-exit oracle confirms the exit of the exact killed object.
  {
    const exec = fakeExec({ queries: [
      { match: /Name='msedgewebview2\.exe'/, output: enumWith(UDF) },
      { match: /ProcessId=101/, output: browserRecord(101, UDF) },
      { match: waitQuery(101), output: WAIT_EXIT },
    ] });
    const api = loadIsolationModule({ exec });
    const report = plain(api.killSandboxBrowsers(SBX));
    assert.deepEqual(report.exitConfirmed, [101]);
    assert.equal(report.enumerationFailed, false);
    assert.deepEqual(exec.kills, [101]);
    assert.ok(exec.calls.some((c) => waitQuery(101).test(`${c.command} ${c.args.join(' ')}`)), 'exit settled through the wait oracle');
  }
  // Main's counterexample: enumeration says owned, the fresh record says
  // foreign → the PID must NOT be killed.
  {
    const { report, kills } = run([
      { match: /Name='msedgewebview2\.exe'/, output: enumWith(UDF) },
      { match: /ProcessId=101/, output: browserRecord(101, 'C:\\Users\\u\\WB2') },
    ]);
    assert.deepEqual(report.exitConfirmed, []);
    assert.deepEqual(kills, []);
    assert.ok((report.foreignNow || []).includes(101), 'recorded as changed to foreign');
  }
  // Unreadable fresh metadata (Name present, CommandLine null; and Name null)
  // → unknown uncertainty, NOT foreignNow and not silently dropped from
  // cleanup reporting (main's r3 residual).
  {
    const { report, kills } = run([
      { match: /Name='msedgewebview2\.exe'/, output: enumWith(UDF) },
      { match: /ProcessId=101/, output: okEnvelope([{ ProcessId: 101, Name: 'msedgewebview2.exe', CommandLine: null, ExecutablePath: 'C:\\wv\\msedgewebview2.exe', ParentProcessId: 555, CreationDate: dateToken(T0) }]) },
    ]);
    assert.deepEqual(report.exitConfirmed, []);
    assert.deepEqual(report.unknown, [101]);
    assert.deepEqual(report.foreignNow, []);
    assert.deepEqual(kills, []);
  }
  {
    const { report, kills } = run([
      { match: /Name='msedgewebview2\.exe'/, output: enumWith(UDF) },
      { match: /ProcessId=101/, output: okEnvelope([{ ProcessId: 101, Name: null, CommandLine: null, ExecutablePath: null, ParentProcessId: 555, CreationDate: dateToken(T0) }]) },
    ]);
    assert.deepEqual(report.unknown, [101]);
    assert.deepEqual(report.foreignNow, []);
    assert.deepEqual(kills, []);
  }
  // A malformed enumeration entry ([null]) makes the whole enumeration
  // uncertain — explicit enumerationFailed, never a crash.
  {
    const { report, kills } = run([
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([null]) },
    ]);
    assert.equal(report.enumerationFailed, true);
    assert.deepEqual(report.exitConfirmed, []);
    assert.deepEqual(kills, []);
  }
  // Per-PID recheck fails (unreadable) → unknown, not killed.
  {
    const { report, kills } = run([
      { match: /Name='msedgewebview2\.exe'/, output: enumWith(UDF) },
      { match: /ProcessId=101/, output: errEnvelope('access denied') },
    ]);
    assert.deepEqual(report.exitConfirmed, []);
    assert.deepEqual(report.unknown, [101]);
    assert.deepEqual(kills, []);
  }
  // PID already gone at recheck time → exit confirmed by the fresh empty
  // record; no kill requested, not a failure.
  {
    const { report, kills } = run([
      { match: /Name='msedgewebview2\.exe'/, output: enumWith(UDF) },
      { match: /ProcessId=101/, output: goneRecord() },
    ]);
    assert.deepEqual(report.exitConfirmed, [101]);
    assert.deepEqual(report.unknown, []);
    assert.deepEqual(kills, []);
  }
  // Kill attempt refused while the process observably still runs → pending
  // (termination requested, exit not observed), never silently swallowed.
  {
    const exec = fakeExec({ taskkill: () => { const e = new Error('refused'); e.status = 1; throw e; }, queries: [
      { match: /Name='msedgewebview2\.exe'/, output: enumWith(UDF) },
      { match: /ProcessId=101/, output: browserRecord(101, UDF) },
      { match: waitQuery(101), output: WAIT_PENDING },
    ] });
    const api = loadIsolationModule({ exec });
    const report = plain(api.killSandboxBrowsers(SBX));
    assert.deepEqual(report.pending, [101]);
    assert.equal(report.killErrors[101].status, 1, 'original taskkill error preserved');
    assert.deepEqual(exec.kills, [101]);
  }
  // Enumeration failure is explicit uncertainty, not an empty success.
  {
    const { report, kills } = run([
      { match: /Name='msedgewebview2\.exe'/, output: errEnvelope('WMI down') },
    ]);
    assert.equal(report.enumerationFailed, true);
    assert.deepEqual(report.exitConfirmed, []);
    assert.deepEqual(kills, []);
  }
  // No candidate had profile evidence (prefix collision, unsupported
  // spelling, metadata absent) → skipped, never killed.
  {
    const { report, kills } = run([
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([
        { ProcessId: 201, CommandLine: `${WV_ARGV0} --user-data-dir=${SBX}DEF\\webview-1` },
        { ProcessId: 202, CommandLine: `${WV_ARGV0} --user-data-folder=${UDF}` },
        { ProcessId: 203, CommandLine: null },
      ]) },
    ]);
    assert.deepEqual(report.exitConfirmed, []);
    assert.deepEqual(kills, []);
    assert.equal(report.skippedUnproven, 3);
  }
  // No sandbox directory → nothing queried, nothing killed.
  {
    const exec = fakeExec({ queries: [] });
    const api = loadIsolationModule({ exec });
    assert.deepEqual(plain(api.killSandboxBrowsers(undefined)), {
      exitConfirmed: [], pending: [], unknown: [], foreignNow: [], skippedUnproven: 0, enumerationFailed: false, killErrors: {},
    });
    assert.deepEqual(exec.calls, []);
  }
});

// ── batch06 cleanup correction: every termination settles through the
// handle-exit oracle (retained Windows process handle + exit signal), never
// through taskkill prose/exit codes, WMI listing presence alone, or messages.
// Vocabulary per identity: termination requested (killErrors), exit confirmed,
// pending (exit not observed in budget), unknown (unreadable), foreign/reuse.
test('killSandboxBrowsers separates pending termination, survivor, unknown and reuse', () => {
  const UDF = `${SBX}\\webview-1`;
  const enumWith = () => okEnvelope([{ ProcessId: 101, CommandLine: wvLine(UDF) }]);
  const run = (routes, taskkill) => {
    const exec = fakeExec({ taskkill, queries: routes });
    const api = loadIsolationModule({ exec });
    return { report: plain(api.killSandboxBrowsers(SBX)), exec };
  };
  const refused = () => { const e = new Error('Command failed: taskkill.exe /PID 101 /F'); e.status = 1; throw e; };
  // The exp1 red-loop signature: taskkill exit 1 "no instance running" while
  // the pid was already exiting — the oracle confirms the exit of the exact
  // pinned object, so this is NEITHER a survivor NOR unknown.
  {
    const { report, exec } = run([
      { match: /Name='msedgewebview2\.exe'/, output: enumWith() },
      { match: /ProcessId=101/, output: browserRecord(101, UDF) },
      { match: waitQuery(101), output: WAIT_EXIT },
    ], refused);
    assert.deepEqual(report.exitConfirmed, [101], 'exit confirmed despite taskkill failure');
    assert.deepEqual(report.pending, []);
    assert.deepEqual(report.unknown, []);
    assert.equal(report.killErrors[101].status, 1, 'original command error preserved, uninterpreted');
    assert.deepEqual(exec.kills, [101], 'one termination request for the proven pid');
  }
  // Genuine survivor: kill refused, handle wait times out → pending, not exit.
  {
    const { report } = run([
      { match: /Name='msedgewebview2\.exe'/, output: enumWith() },
      { match: /ProcessId=101/, output: browserRecord(101, UDF) },
      { match: waitQuery(101), output: WAIT_PENDING },
    ], refused);
    assert.deepEqual(report.pending, [101]);
    assert.deepEqual(report.exitConfirmed, []);
  }
  // Denied/unreadable status: the oracle query itself fails → unknown, never
  // downgraded to confirmed or pending.
  {
    const { report } = run([
      { match: /Name='msedgewebview2\.exe'/, output: enumWith() },
      { match: /ProcessId=101/, output: browserRecord(101, UDF) },
      { match: waitQuery(101), output: errEnvelope('Access is denied') },
    ], refused);
    assert.deepEqual(report.unknown, [101]);
  }
  // PID reuse at settle time: the pinned creation time no longer matches →
  // the killed object is gone; the pid's new occupant is left alive.
  {
    const { report, exec } = run([
      { match: /Name='msedgewebview2\.exe'/, output: enumWith() },
      { match: /ProcessId=101/, output: browserRecord(101, UDF) },
      { match: waitQuery(101), output: WAIT_REUSE },
    ], refused);
    assert.deepEqual(report.foreignNow, [101]);
    assert.deepEqual(report.exitConfirmed, []);
    assert.deepEqual(exec.kills, [101], 'only the previously-proven pid was terminated');
  }
  // Handle cannot be opened (not-found): corroborate with a FRESH WMI record
  // before believing anything. Gone → exit confirmed; disagreement → unknown.
  {
    let records = 0;
    const { report } = run([
      { match: /Name='msedgewebview2\.exe'/, output: enumWith() },
      { match: /ProcessId=101/, output: () => (records++ === 0 ? browserRecord(101, UDF) : goneRecord()) },
      { match: waitQuery(101), output: WAIT_NOT_FOUND },
    ], refused);
    assert.deepEqual(report.exitConfirmed, [101], 'not-found + corroborating absence = confirmed exit');
  }
  {
    const { report } = run([
      { match: /Name='msedgewebview2\.exe'/, output: enumWith() },
      { match: /ProcessId=101/, output: browserRecord(101, UDF) },
      { match: waitQuery(101), output: WAIT_NOT_FOUND },
    ], refused);
    assert.deepEqual(report.unknown, [101], 'listing/open disagreement stays unknown');
  }
  // Open error on the handle (denied class) → unknown.
  {
    const { report } = run([
      { match: /Name='msedgewebview2\.exe'/, output: enumWith() },
      { match: /ProcessId=101/, output: browserRecord(101, UDF) },
      { match: waitQuery(101), output: WAIT_OPEN_ERROR },
    ], refused);
    assert.deepEqual(report.unknown, [101]);
  }
  // No creation-time evidence at the boundary → the settle cannot be pinned;
  // fail closed as unknown WITHOUT a kill (pid reuse cannot be excluded).
  {
    const { report, exec } = run([
      { match: /Name='msedgewebview2\.exe'/, output: enumWith() },
      { match: /ProcessId=101/, output: browserRecord(101, UDF, { CreationDate: undefined }) },
    ]);
    assert.deepEqual(report.unknown, [101]);
    assert.deepEqual(exec.kills, [], 'no termination without a pinnable identity');
  }
});

test('killOwnedRuntime computes final per-identity outcomes from fresh evidence', () => {
  const UDF = `${SBX}\\webview-1`;
  const child = hostChild(555);
  const hostKilled = () => ({ match: /ProcessId=555/, output: dyingHostRecord() });
  const hostWait = { match: waitQuery(555), output: WAIT_EXIT };
  // Later confirmed exit: round 0 pending, round 1 confirms → exactly true.
  // (Old contract: the round-0 failure reason persisted forever.)
  {
    let waits = 0;
    const exec = fakeExec({ taskkill: (pid) => { if (pid !== 555) { const e = new Error('no instance'); e.status = 1; throw e; } return ''; }, queries: [
      hostKilled(), hostWait,
      { match: /Name='msedgewebview2\.exe'/, output: () => okEnvelope([{ ProcessId: 101, CommandLine: wvLine(UDF) }]) },
      { match: /ProcessId=101/, output: browserRecord(101, UDF) },
      { match: waitQuery(101), output: () => (waits++ === 0 ? WAIT_PENDING : WAIT_EXIT) },
      { match: /LocalPort -eq 9222/, output: () => okEnvelope([101]) },
    ] });
    const result = loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true });
    assert.equal(result, true, 'a later round proving the exit retracts the earlier pending state');
  }
  // Stale-reason elimination: round 0 pending, round 1 the pid is simply gone
  // (enumeration empty, per-PID query empty, port free) → exactly true.
  {
    let enums = 0; let listeners = 0;
    const exec = fakeExec({ taskkill: () => { const e = new Error('no instance'); e.status = 1; throw e; }, queries: [
      hostKilled(), hostWait,
      { match: /Name='msedgewebview2\.exe'/, output: () => (enums++ === 0 ? okEnvelope([{ ProcessId: 101, CommandLine: wvLine(UDF) }]) : okEnvelope([])) },
      { match: /ProcessId=101/, output: () => (enums === 1 ? browserRecord(101, UDF) : goneRecord()) },
      { match: waitQuery(101), output: WAIT_PENDING },
      { match: /LocalPort -eq 9222/, output: () => (listeners++ === 0 ? okEnvelope([101]) : okEnvelope([])) },
    ] });
    const result = loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true });
    assert.equal(result, true, 'an obsolete round-0 failure must not survive fresh contrary evidence');
  }
  // Lingering listener metadata: the browser's exit is handle-confirmed while
  // the LISTEN socket still shows the pid — resource release is reported
  // apart from process exit and does not fabricate a survivor.
  {
    const exec = fakeExec({ taskkill: () => { const e = new Error('no instance'); e.status = 1; throw e; }, queries: [
      hostKilled(), hostWait,
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([{ ProcessId: 101, CommandLine: wvLine(UDF) }]) },
      { match: /ProcessId=101/, output: browserRecord(101, UDF) },
      { match: waitQuery(101), output: WAIT_EXIT },
      { match: /LocalPort -eq 9222/, output: okEnvelope([101]) },
    ] });
    const result = loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true });
    assert.equal(result, true, 'confirmed exit + lingering socket metadata is not a survivor');
  }
  // exp6 case: a pending browser whose LISTEN socket already released (audit
  // free) must still consume its budgeted rounds — the next round's fresh
  // evidence retracts the pending state when the exit completes just after
  // the settle budget (native: exp6 hygiene returned true in 2.0 s).
  {
    let enums = 0;
    const exec = fakeExec({ taskkill: (pid) => { if (pid !== 555) { const e = new Error('no instance'); e.status = 1; throw e; } return ''; }, queries: [
      hostKilled(), hostWait,
      { match: /Name='msedgewebview2\.exe'/, output: () => (enums++ === 0 ? okEnvelope([{ ProcessId: 101, CommandLine: wvLine(UDF) }]) : okEnvelope([])) },
      { match: /ProcessId=101/, output: () => (enums === 1 ? browserRecord(101, UDF) : goneRecord()) },
      { match: waitQuery(101), output: WAIT_PENDING },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true });
    assert.equal(result, true, 'a free port must not end the rounds while a termination is still pending');
    assert.deepEqual(exec.kills.filter((pid) => pid === 101), [101], 'no re-kill without a fresh owned record');
  }
  // Real survivor: pending through every bounded round → explicit failure,
  // bounded retries, original error preserved.
  {
    const exec = fakeExec({ taskkill: () => { const e = new Error('refused'); e.status = 1; throw e; }, queries: [
      hostKilled(), hostWait,
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([{ ProcessId: 101, CommandLine: wvLine(UDF) }]) },
      { match: /ProcessId=101/, output: browserRecord(101, UDF) },
      { match: waitQuery(101), output: WAIT_PENDING },
      { match: /LocalPort -eq 9222/, output: okEnvelope([101]) },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true }));
    assert.equal(result.ok, false);
    assert.match(result.reasons.join('; '), /exit not observed/);
    assert.ok(exec.kills.filter((pid) => pid === 101).length >= 2, 'retried with fresh ownership proof');
    assert.ok(exec.kills.filter((pid) => pid === 101).length <= 3, 'bounded retries');
  }
  // Locked profile guard: even a fully established cleanup never removes the
  // sandbox directory — release of the profile stays with the exit hook /
  // stale sweep, separate from process exit.
  {
    const root = freshScratch('locked-profile-');
    const source = join(root, 'source');
    mkdirSync(join(source, 'data'), { recursive: true });
    writeFileSync(join(source, 'zterm.exe'), 'stub executable');
    const box = createE2eSandbox(join(source, 'zterm.exe'), root);
    const exec = fakeExec({ queries: [
      hostKilled(), hostWait,
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([]) },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: box.directory, launchPort: 9222, launched: true });
    assert.equal(result, true);
    assert.equal(existsSync(box.directory), true, 'cleanup verdicts never delete the profile directory');
  }
  // Foreign processes stay untouched even when the oracle is in play: no wait
  // query and no kill for candidates without ownership evidence; the host
  // kill (proven ours) is the only termination.
  {
    const exec = fakeExec({ queries: [
      hostKilled(), hostWait,
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([
        { ProcessId: 201, CommandLine: `${WV_ARGV0} --user-data-dir=${SBX}DEF\\webview-1`, CreationDate: dateToken(T0) },
        { ProcessId: 202, CommandLine: null },
      ]) },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true });
    assert.equal(result, true);
    assert.deepEqual(exec.kills, [555], 'only the proven-owned host pid is terminated');
    assert.ok(exec.kills.every((pid) => pid !== 201 && pid !== 202), 'unproven candidates never killed');
    assert.ok(!exec.calls.some((c) => /Get-Process -Id (201|202)/.test(c.args.join(' '))), 'no oracle query for unproven candidates');
  }
});

test('killOwnedRuntime retains pending candidates when enumeration loses their ownership metadata', () => {
  for (const missingFromEnumeration of [false, true]) {
    let rounds = 0;
    const exec = fakeExec({ queries: [
      { match: /Name='msedgewebview2\.exe'/, output: () => {
        rounds++;
        return okEnvelope(rounds > 1 && missingFromEnumeration ? [] : [{
          ProcessId: 101, CommandLine: rounds === 1 ? wvLine(`${SBX}\\webview-1`) : null,
        }]);
      } },
      { match: /ProcessId=101/, output: browserRecord(101, `${SBX}\\webview-1`) },
      { match: waitQuery(101), output: WAIT_PENDING },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child: null, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true,
    }));
    assert.equal(result.ok, false, 'enumeration disappearance is not exit evidence');
    assert.match(result.reasons.join('; '), /pid 101.*exit not observed/);
    assert.equal(rounds, 3, 'the known pending identity consumes the bounded retry rounds');
    assert.deepEqual(exec.kills, [101, 101, 101], 'each retry uses fresh per-PID ownership evidence');
  }
});

test('killOwnedRuntime retains unresolved candidates across calls only for the same sandbox', () => {
  let phase = 'discovery';
  let identityQueries = 0;
  const exec = fakeExec({ queries: [
    { match: /Name='msedgewebview2\.exe'/, output: () => okEnvelope([{
      ProcessId: 101, CommandLine: phase === 'discovery' ? wvLine(`${SBX}\\webview-1`) : null,
    }]) },
    { match: /ProcessId=101/, output: () => {
      identityQueries++;
      return phase === 'absent' ? goneRecord() : browserRecord(101, `${SBX}\\webview-1`);
    } },
    { match: waitQuery(101), output: WAIT_PENDING },
    { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
  ] });
  const api = loadIsolationModule({ exec });
  const cleanup = (sandboxDirectory = SBX) => api.killOwnedRuntime({
    child: null, executable: HOST_EXE, sandboxDirectory, launchPort: 9222, launched: true,
  });
  const first = plain(cleanup());
  assert.equal(first.ok, false);
  assert.match(first.reasons.join('; '), /pid 101.*exit not observed/);
  phase = 'unreadable-enumeration';
  const second = plain(cleanup(SBX.toUpperCase() + '\\'));
  assert.equal(second.ok, false, 'a later call retains candidates for the same normalized sandbox');
  assert.match(second.reasons.join('; '), /pid 101.*exit not observed/);
  assert.equal(identityQueries, 6, 'each bounded sweep freshly revalidates the retained candidate');
  assert.deepEqual(exec.kills, [101, 101, 101, 101, 101, 101]);
  assert.equal(cleanup(`${SBX}-other`), true, 'another sandbox does not inherit the unresolved candidate');
  assert.equal(identityQueries, 6, 'another sandbox does not query the retained PID');
  assert.equal(exec.kills.length, 6, 'another sandbox does not terminate the retained PID');
  phase = 'absent';
  assert.equal(cleanup(), true, 'a fresh per-PID absence resolves the retained candidate');
  assert.equal(identityQueries, 7);
  phase = 'unreadable-enumeration';
  assert.equal(cleanup(), true, 'resolved candidates are released before later cleanup calls');
  assert.equal(identityQueries, 7, 'resolved identities are no longer queried');
  assert.equal(exec.kills.length, 6);
});

test('known pending and unknown candidates survive unreadable metadata until fresh absence confirms exit', () => {
  for (const initialWait of [WAIT_PENDING, WAIT_OPEN_ERROR]) {
    for (const unreadable of [errEnvelope('access denied'), browserRecord(101, `${SBX}\\webview-1`, { CommandLine: null })]) {
      let rounds = 0;
      const exec = fakeExec({ queries: [
        { match: /Name='msedgewebview2\.exe'/, output: () => {
          rounds++;
          return okEnvelope(rounds === 1 ? [{ ProcessId: 101, CommandLine: wvLine(`${SBX}\\webview-1`) }] : []);
        } },
        { match: /ProcessId=101/, output: () => rounds === 1 ? browserRecord(101, `${SBX}\\webview-1`)
          : rounds === 2 ? unreadable : goneRecord() },
        { match: waitQuery(101), output: initialWait },
      ] });
      const api = loadIsolationModule({ exec });
      const knownCandidates = new Set();
      const first = plain(api.killSandboxBrowsers(SBX, { knownCandidates }));
      assert.deepEqual(initialWait === WAIT_PENDING ? first.pending : first.unknown, [101]);
      assert.deepEqual([...knownCandidates], [101]);
      const second = plain(api.killSandboxBrowsers(SBX, { knownCandidates }));
      assert.deepEqual(second.unknown, [101], 'unreadable metadata retains the unresolved candidate');
      assert.deepEqual(second.exitConfirmed, []);
      assert.deepEqual([...knownCandidates], [101]);
      const third = plain(api.killSandboxBrowsers(SBX, { knownCandidates }));
      assert.deepEqual(third.exitConfirmed, [101], 'fresh per-PID absence establishes exit');
      assert.deepEqual(third.unknown, []);
      assert.deepEqual([...knownCandidates], []);
      assert.deepEqual(exec.kills, [101], 'unreadable or absent identity never authorizes another kill');
    }
  }
});

test('killOwnedRuntime reports a previously pending PID whose fresh metadata becomes unreadable', () => {
  let rounds = 0;
  const exec = fakeExec({ queries: [
    { match: /Name='msedgewebview2\.exe'/, output: () => okEnvelope([{
      ProcessId: 101, CommandLine: rounds++ === 0 ? wvLine(`${SBX}\\webview-1`) : null,
    }]) },
    { match: /ProcessId=101/, output: () => rounds === 1 ? browserRecord(101, `${SBX}\\webview-1`) : errEnvelope('denied') },
    { match: waitQuery(101), output: WAIT_PENDING },
    { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
  ] });
  const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
    child: null, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true,
  }));
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('; '), /pid 101.*exit not observed/);
  assert.deepEqual(exec.kills, [101]);
});

test('previously owned pending identities can finish read-only after ownership metadata becomes unreadable', () => {
  const UDF = `${SBX}\\webview-1`;
  const unreadableRecords = [
    errEnvelope('denied'),
    browserRecord(101, UDF, { Name: null }),
    browserRecord(101, UDF, { CommandLine: null }),
    browserRecord(101, UDF, { CreationDate: null }),
  ];
  for (const unreadable of unreadableRecords) {
    let rounds = 0;
    const exec = fakeExec({ queries: [
      { match: /Name='msedgewebview2\.exe'/, output: () => {
        rounds++;
        return okEnvelope(rounds === 1 ? [{ ProcessId: 101, CommandLine: wvLine(UDF) }] : []);
      } },
      { match: /ProcessId=101/, output: () => rounds === 1 ? browserRecord(101, UDF) : unreadable },
      { match: waitQuery(101), output: () => rounds === 1 ? WAIT_PENDING : WAIT_EXIT },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = loadIsolationModule({ exec }).killOwnedRuntime({
      child: null, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true,
    });
    assert.equal(result, true, 'the prior exact creation identity authorizes a read-only exit observation');
    assert.equal(rounds, 2);
    assert.deepEqual(exec.kills, [101], 'unreadable ownership never authorizes another termination');
    const waits = exec.calls.filter((c) => waitQuery(101).test(c.args.join(' ')));
    assert.equal(waits.length, 2);
    for (const call of waits) assert.match(call.args.join(' '), new RegExp(`\\$startMs -ne ${T0}\\b`));
  }
});

test('unreadable ownership and a failed read-only oracle remain unknown without another kill', () => {
  for (const unavailable of [WAIT_OPEN_ERROR, errEnvelope('oracle unavailable')]) {
    let rounds = 0;
    const exec = fakeExec({ queries: [
      { match: /Name='msedgewebview2\.exe'/, output: () => {
        rounds++;
        return okEnvelope(rounds === 1 ? [{ ProcessId: 101, CommandLine: wvLine(`${SBX}\\webview-1`) }] : []);
      } },
      { match: /ProcessId=101/, output: () => rounds === 1 ? browserRecord(101, `${SBX}\\webview-1`) : errEnvelope('denied') },
      { match: waitQuery(101), output: () => rounds === 1 ? WAIT_PENDING : unavailable },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child: null, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true,
    }));
    assert.equal(result.ok, false);
    assert.match(result.reasons.join('; '), /pid 101.*could not be re-verified/);
    assert.equal(rounds, 3);
    assert.deepEqual(exec.kills, [101]);
  }
});

test('read-only reuse observation does not cache an exit for the new process identity', () => {
  let phase = 'owned';
  const UDF = `${SBX}\\webview-1`;
  const exec = fakeExec({ queries: [
    { match: /Name='msedgewebview2\.exe'/, output: () => okEnvelope(phase === 'owned' ? [{ ProcessId: 101, CommandLine: wvLine(UDF) }] : []) },
    { match: /ProcessId=101/, output: () => browserRecord(101, UDF, phase === 'owned' ? {} : {
      CreationDate: dateToken(T0 + 600000), ...(phase === 'unreadable' ? { CommandLine: null } : {}),
    }) },
    { match: waitQuery(101), output: () => phase === 'unreadable' ? WAIT_REUSE : WAIT_PENDING },
    { match: /LocalPort -eq 9222/, output: okEnvelope([101]) },
  ] });
  const api = loadIsolationModule({ exec });
  const knownCandidates = new Set();
  const knownStarts = new Map();
  api.killSandboxBrowsers(SBX, { knownCandidates, knownStarts });
  assert.equal(knownStarts.get(101), T0);
  phase = 'unreadable';
  const exitStates = new Map();
  const report = plain(api.killSandboxBrowsers(SBX, { knownCandidates, knownStarts, exitStates }));
  assert.deepEqual(report.foreignNow, [101]);
  assert.deepEqual(report.exitConfirmed, []);
  assert.equal(exitStates.has(101), false, 'reuse is not a confirmed exit for the new identity');
  assert.equal(knownCandidates.has(101), false);
  assert.equal(knownStarts.has(101), false);
  phase = 'audit';
  const audit = plain(api.auditPortListeners(9222, SBX, { exitStates }));
  assert.equal(audit.findings[0].class, 'owned-browser', 'the new live identity is observed independently');
  assert.deepEqual(exec.kills, [101], 'only the initially proven identity received a termination request');
});

test('killOwnedRuntime retries unknown candidates until later verified absence recovers cleanup', () => {
  for (const initialWait of [WAIT_PENDING, WAIT_OPEN_ERROR]) {
    let rounds = 0;
    const exec = fakeExec({ queries: [
      { match: /Name='msedgewebview2\.exe'/, output: () => {
        rounds++;
        return okEnvelope(rounds === 1 ? [{ ProcessId: 101, CommandLine: wvLine(`${SBX}\\webview-1`) }] : []);
      } },
      { match: /ProcessId=101/, output: () => rounds === 1 ? browserRecord(101, `${SBX}\\webview-1`)
        : rounds === 2 ? errEnvelope('denied') : goneRecord() },
      { match: waitQuery(101), output: initialWait },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = loadIsolationModule({ exec }).killOwnedRuntime({
      child: null, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true,
    });
    assert.equal(result, true, 'later per-PID absence supersedes an earlier unknown outcome');
    assert.equal(rounds, 3, 'unknown candidates retain bounded retries even with a free port');
    assert.deepEqual(exec.kills, [101], 'only the initial verified identity is terminated');
  }
});

test('the exit oracle pins a handle before exact creation-time comparison and disposes it in finally', () => {
  const exec = fakeExec({ queries: [
    { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([{ ProcessId: 101, CommandLine: wvLine(`${SBX}\\webview-1`) }]) },
    { match: /ProcessId=101/, output: browserRecord(101, `${SBX}\\webview-1`) },
    { match: waitQuery(101), output: WAIT_EXIT },
  ] });
  loadIsolationModule({ exec }).killSandboxBrowsers(SBX);
  const call = exec.calls.find((c) => waitQuery(101).test(c.args.join(' ')));
  assert.ok(call, 'the real boundary emitted an exit-oracle script');
  const script = call.args.join(' ');
  assert.match(script, /\[void\]\$proc\.Handle\s+\$startMs =/);
  assert.match(script, new RegExp(`if \\(\\$startMs -ne ${T0}\\)`));
  assert.ok(script.indexOf('$proc.Handle') < script.indexOf('$proc.WaitForExit('));
  assert.match(script, /finally\s*\{\s*if \(\$null -ne \$proc\) \{ \$proc\.Dispose\(\) \}/);
});

test('host termination settles through the retained-handle oracle', () => {
  const child = hostChild(555);
  // taskkill fails against the host ghost record, the oracle confirms the
  // exit of the pinned object → killed, not failed (exp1 host analogue). The
  // port is then held by a foreign process so the run still reports — which
  // also exposes the host disposition for assertion.
  {
    const exec = fakeExec({ taskkill: () => { const e = new Error('no instance'); e.status = 1; throw e; }, queries: [
      { match: /ProcessId=555/, output: hostRecord(555) },
      { match: waitQuery(555), output: WAIT_EXIT },
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([]) },
      { match: /LocalPort -eq 9222/, output: okEnvelope([777]) },
      { match: /ProcessId=777/, output: hostRecord(777, 'C:\\Users\\u\\zterm.exe') },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true }));
    assert.equal(result.ok, false, 'foreign port holder still reported');
    assert.equal(result.hostDisposition, 'killed', 'host exit confirmed through the oracle despite taskkill failure');
    assert.match(result.reasons.join('; '), /not proven owned by this run/);
    assert.deepEqual(exec.kills, [555], 'the foreign holder is never killed');
  }
  // Pending across both verified attempts → failed with the observed reason.
  {
    const exec = fakeExec({ taskkill: () => { const e = new Error('refused'); e.status = 1; throw e; }, queries: [
      { match: /ProcessId=555/, output: hostRecord(555) },
      { match: waitQuery(555), output: WAIT_PENDING },
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([]) },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true }));
    assert.equal(result.ok, false);
    assert.equal(result.hostDisposition, 'failed');
    assert.match(result.reasons.join('; '), /exit not observed/);
    assert.ok(exec.calls.filter((c) => waitQuery(555).test(`${c.command} ${c.args.join(' ')}`)).length >= 2, 'each attempt settled through the oracle');
  }
});

test('auditPortListeners separates process exit from actual port release', () => {
  const run = (routes) => {
    const exec = fakeExec({ queries: routes });
    const api = loadIsolationModule({ exec });
    return { result: plain(api.auditPortListeners(9222, SBX)), kills: exec.kills, calls: exec.calls };
  };
  const UDF = `${SBX}\\webview-1`;
  // Owned listener whose exit is handle-confirmed while the socket lingers:
  // classified as gone-with-confirmed-exit (lingering metadata), never as a
  // surviving owned browser.
  {
    const { result, kills } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([888]) },
      { match: /ProcessId=888/, output: browserRecord(888, UDF) },
      { match: waitQuery(888), output: WAIT_EXIT },
    ]);
    assert.deepEqual(result, { state: 'held', findings: [{ pid: 888, class: 'gone', exitConfirmed: true }] });
    assert.deepEqual(kills, []);
  }
  // Same state, but the sweep of THIS cleanup already confirmed the exit: the
  // audit reuses that fresh observation instead of re-waiting.
  {
    const exec = fakeExec({ queries: [
      { match: /LocalPort -eq 9222/, output: okEnvelope([888]) },
      { match: /ProcessId=888/, output: browserRecord(888, UDF) },
    ] });
    const api = loadIsolationModule({ exec });
    const result = plain(api.auditPortListeners(9222, SBX, { exitStates: new Map([[888, { startMs: T0, state: 'exit-confirmed' }]]) }));
    assert.deepEqual(result, { state: 'held', findings: [{ pid: 888, class: 'gone', exitConfirmed: true }] });
    assert.ok(!exec.calls.some((c) => /Get-Process -Id/.test(c.args.join(' '))), 'no duplicate wait for an exit confirmed this round');
    assert.deepEqual(exec.kills, []);
  }
  // Owned listener still observably running (pending) → stays owned-browser.
  {
    const { result, kills } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([888]) },
      { match: /ProcessId=888/, output: browserRecord(888, UDF) },
      { match: waitQuery(888), output: WAIT_PENDING },
    ]);
    assert.deepEqual(result, { state: 'held', findings: [{ pid: 888, class: 'owned-browser', name: 'msedgewebview2.exe' }] });
    assert.deepEqual(kills, []);
  }
  // Oracle unreadable for the listener → unknown finding, fail closed.
  {
    const { result } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([888]) },
      { match: /ProcessId=888/, output: browserRecord(888, UDF) },
      { match: waitQuery(888), output: errEnvelope('denied') },
    ]);
    assert.deepEqual(result, { state: 'held', findings: [{ pid: 888, class: 'unknown' }] });
  }
});

test('auditPortListeners rejects PID-only and mismatched-identity exit caches', () => {
  const cases = [
    { cached: 'exit-confirmed', freshStart: T0, wait: WAIT_PENDING, classification: 'owned-browser' },
    { cached: { startMs: T0, state: 'exit-confirmed' }, freshStart: T0 + 1, wait: WAIT_PENDING, classification: 'owned-browser' },
    { cached: { startMs: T0 - 1, state: 'exit-confirmed' }, freshStart: T0, wait: WAIT_PENDING, classification: 'owned-browser' },
    { cached: { startMs: T0, state: 'exit-pending' }, freshStart: T0 + 1, wait: WAIT_EXIT, classification: 'gone' },
    { cached: { startMs: T0, state: 'unknown' }, freshStart: T0 + 1, wait: WAIT_EXIT, classification: 'gone' },
  ];
  for (const { cached, freshStart, wait, classification } of cases) {
    const exec = fakeExec({ queries: [
      { match: /LocalPort -eq 9222/, output: okEnvelope([888]) },
      { match: /ProcessId=888/, output: browserRecord(888, `${SBX}\\webview-1`, { CreationDate: dateToken(freshStart) }) },
      { match: waitQuery(888), output: wait },
    ] });
    const result = plain(loadIsolationModule({ exec }).auditPortListeners(9222, SBX, {
      exitStates: new Map([[888, cached]]),
    }));
    assert.equal(result.findings[0].class, classification, JSON.stringify(cached));
    assert.equal(exec.calls.filter((c) => waitQuery(888).test(c.args.join(' '))).length, 1,
      'a stale cache must settle the freshly observed process identity');
    assert.deepEqual(exec.kills, [], 'audit remains read-only');
  }
});

test('killOwnedRuntime never kills a host child without fresh identity proof', () => {
  const child = hostChild(555);
  // Identity query fails repeatedly → NO taskkill may happen at all.
  {
    const exec = fakeExec({ queries: [
      { match: /ProcessId=555/, output: errEnvelope('access denied') },
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([]) },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true }));
    assert.equal(result.ok, false);
    assert.equal(result.hostDisposition, 'unknown');
    assert.match(result.reasons.join('; '), /identity unreadable|identity query failed/);
    assert.deepEqual(exec.kills, [], 'no kill without ownership proof');
  }
  // PID metadata changed (foreign executable) → mismatch, host left alive,
  // browsers and port audit still run.
  {
    const exec = fakeExec({ queries: [
      { match: /ProcessId=555/, output: hostRecord(555, 'C:\\Users\\u\\zterm.exe') },
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([]) },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true }));
    assert.equal(result.ok, false);
    assert.equal(result.hostDisposition, 'mismatch');
    assert.match(result.reasons.join('; '), /no longer runs the sandbox executable/);
    assert.deepEqual(exec.kills, []);
  }
  // Verified kill: taskkill races an exiting process, throws; the handle-exit
  // oracle confirms the pinned object exited → killed, no failure, no blind retry.
  {
    let queriesFor555 = 0;
    const exec = fakeExec({ taskkill: () => { throw new Error('race'); }, queries: [
      { match: /ProcessId=555/, output: () => (queriesFor555++ === 0 ? hostRecord(555) : goneRecord()) },
      { match: waitQuery(555), output: WAIT_EXIT },
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([]) },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true });
    assert.equal(result, true);
    assert.deepEqual(exec.kills, [555], 'one verified attempt only');
  }
  // Survives two VERIFIED termination attempts (exit never observed) → failure
  // with an explicit reason.
  {
    const exec = fakeExec({ taskkill: () => { throw new Error('refused'); }, queries: [
      { match: /ProcessId=555/, output: hostRecord(555) },
      { match: waitQuery(555), output: WAIT_PENDING },
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([]) },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true }));
    assert.equal(result.ok, false);
    assert.equal(result.hostDisposition, 'failed');
    assert.match(result.reasons.join('; '), /exit not observed/);
    assert.deepEqual(exec.kills, [555, 555], 'retry only after proof, bounded');
  }
  // Already dead (no record) → clean, no kill attempted.
  {
    const exec = fakeExec({ queries: [
      { match: /ProcessId=555/, output: goneRecord() },
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([]) },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true });
    assert.equal(result, true);
    assert.deepEqual(exec.kills, []);
  }
  // Main's r3 counterexample: taskkill is denied, the oracle cannot open the
  // handle, and the NEXT query returns a live record with ExecutablePath
  // null. An unreadable executable is NOT proof of reuse/termination — the
  // result must be unknown/incomplete, not success, so the caller retains the
  // live handle.
  {
    let queriesFor555 = 0;
    const exec = fakeExec({ taskkill: () => { throw new Error('access denied'); }, queries: [
      { match: /ProcessId=555/, output: () => (queriesFor555++ === 0
        ? hostRecord(555)
        : okEnvelope([{ ProcessId: 555, Name: 'zterm.exe', CommandLine: null, ExecutablePath: null, ParentProcessId: 4, CreationDate: dateToken(T0 - 5000) }])) },
      { match: waitQuery(555), output: WAIT_OPEN_ERROR },
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([]) },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true }));
    assert.equal(result.ok, false, 'unreadable identity is not termination success');
    assert.equal(result.hostDisposition, 'unknown', 'live handle retained');
    assert.match(result.reasons.join('; '), /unreadable|unverified/);
  }
  // A VALID different executable after the kill IS positive reuse evidence —
  // the original process is provably gone.
  {
    let queriesFor555 = 0;
    const exec = fakeExec({ taskkill: () => { throw new Error('access denied'); }, queries: [
      { match: /ProcessId=555/, output: () => (queriesFor555++ === 0
        ? hostRecord(555)
        : hostRecord(555, 'C:\\Windows\\notepad.exe')) },
      { match: waitQuery(555), output: WAIT_PENDING },
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([]) },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true });
    assert.equal(result, true, 'proven pid reuse means the original is gone');
  }
});

test('killOwnedRuntime aggregates every cleanup outcome (main counterexample)', () => {
  const child = hostChild(555);
  const hostKilled = () => ({ match: /ProcessId=555/, output: dyingHostRecord() });
  const hostWait = { match: waitQuery(555), output: WAIT_EXIT };
  // Browser termination refused, exit never observed + free debug port →
  // still a failure (a free port is not proof of complete owned cleanup).
  {
    const UDF = `${SBX}\\webview-1`;
    const exec = fakeExec({ taskkill: (pid) => { if (pid !== 555) throw new Error('refused'); return ''; }, queries: [
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([{ ProcessId: 314159, CommandLine: wvLine(UDF) }]) },
      { match: /ProcessId=314159/, output: browserRecord(314159, UDF) },
      { match: waitQuery(314159), output: WAIT_PENDING },
      hostKilled(), hostWait,
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true }));
    assert.equal(result.ok, false);
    assert.match(result.reasons.join('; '), /pid 314159.*exit not observed/);
  }
  // Enumeration failure alone → explicit uncertainty.
  {
    const exec = fakeExec({ queries: [
      hostKilled(),
      { match: /Name='msedgewebview2\.exe'/, output: errEnvelope('denied') },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true }));
    assert.equal(result.ok, false);
    assert.match(result.reasons.join('; '), /enumeration failed/);
  }
  // Unconfirmed browser candidate → uncertainty propagated.
  {
    const UDF = `${SBX}\\webview-1`;
    const exec = fakeExec({ queries: [
      hostKilled(),
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([{ ProcessId: 77, CommandLine: wvLine(UDF) }]) },
      { match: /ProcessId=77/, output: errEnvelope('denied') },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true }));
    assert.equal(result.ok, false);
    assert.match(result.reasons.join('; '), /pid 77.*not.*verified|could not be re-verified/);
  }
  // Foreign holder on the debug port after owned cleanup → reported, left
  // alive, run fails; the foreign pid is never killed.
  {
    const exec = fakeExec({ queries: [
      hostKilled(),
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([]) },
      { match: /LocalPort -eq 9222/, output: okEnvelope([777]) },
      { match: /ProcessId=777/, output: hostRecord(777, 'C:\\Users\\u\\zterm.exe') },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true }));
    assert.equal(result.ok, false);
    assert.match(result.reasons.join('; '), /not proven owned by this run/);
    assert.ok(!exec.kills.includes(777));
  }
  // Owned browser keeps listening across bounded sweeps (exit never observed)
  // → explicit failure.
  {
    const UDF = `${SBX}\\webview-1`;
    const exec = fakeExec({ queries: [
      hostKilled(), hostWait,
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([{ ProcessId: 888, CommandLine: wvLine(UDF) }]) },
      { match: /ProcessId=888/, output: browserRecord(888, UDF) },
      { match: waitQuery(888), output: WAIT_PENDING },
      { match: /LocalPort -eq 9222/, output: okEnvelope([888]) },
    ] });
    const result = plain(loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true }));
    assert.equal(result.ok, false);
    assert.match(result.reasons.join('; '), /still listens after repeated verified sweeps/);
    assert.ok(exec.kills.filter((pid) => pid === 888).length >= 2, 'retried with fresh evidence');
    assert.ok(exec.kills.filter((pid) => pid === 888).length <= 3, 'bounded retries');
  }
  // Positive control: verified host kill, no browsers, free port → exactly true.
  {
    const exec = fakeExec({ queries: [
      hostKilled(), hostWait,
      { match: /Name='msedgewebview2\.exe'/, output: okEnvelope([]) },
      { match: /LocalPort -eq 9222/, output: okEnvelope([]) },
    ] });
    const result = loadIsolationModule({ exec }).killOwnedRuntime({
      child, executable: HOST_EXE, sandboxDirectory: SBX, launchPort: 9222, launched: true });
    assert.equal(result, true);
  }
});

test('auditPortListeners classifies live holders without terminating anything', () => {
  const run = (routes) => {
    const exec = fakeExec({ queries: routes });
    const api = loadIsolationModule({ exec });
    return { result: plain(api.auditPortListeners(9222, SBX)), kills: exec.kills };
  };
  assert.deepEqual(run([{ match: /LocalPort -eq 9222/, output: okEnvelope([]) }]).result, { state: 'free' });
  // Foreign live holder that replaced our process on the port.
  {
    const { result, kills } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([777]) },
      { match: /ProcessId=777/, output: hostRecord(777, 'C:\\Users\\u\\zterm.exe') },
    ]);
    assert.deepEqual(result, { state: 'held', findings: [{ pid: 777, class: 'foreign', name: 'zterm.exe' }] });
    assert.deepEqual(kills, []);
  }
  // Our own browser still listening and observably not yet exited (survived
  // the sweep).
  {
    const { result, kills } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([888]) },
      { match: /ProcessId=888/, output: browserRecord(888, `${SBX}\\webview-1`) },
      { match: waitQuery(888), output: WAIT_PENDING },
    ]);
    assert.deepEqual(result, { state: 'held', findings: [{ pid: 888, class: 'owned-browser', name: 'msedgewebview2.exe' }] });
    assert.deepEqual(kills, []);
  }
  // Dead pid behind a lingering LISTEN socket: no process to prove or kill.
  {
    const { result, kills } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([999]) },
      { match: /ProcessId=999/, output: goneRecord() },
    ]);
    assert.deepEqual(result, { state: 'held', findings: [{ pid: 999, class: 'gone' }] });
    assert.deepEqual(kills, []);
  }
  // Live pid with unreadable metadata: unprovable → reported, not killed.
  {
    const { result, kills } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([111]) },
      { match: /ProcessId=111/, output: errEnvelope('denied') },
    ]);
    assert.deepEqual(result, { state: 'held', findings: [{ pid: 111, class: 'unknown' }] });
    assert.deepEqual(kills, []);
  }
  // Listener query itself fails: unknown, never interpreted as free.
  {
    const { result, kills } = run([{ match: /LocalPort -eq 9222/, output: errEnvelope('denied') }]);
    assert.deepEqual(result, { state: 'unknown' });
    assert.deepEqual(kills, []);
  }
  // Malformed identity payload ([null]) must yield an explicit unknown
  // finding, not a crash and not a foreign/gone classification (main's r3
  // counterexample).
  {
    const { result, kills } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([112]) },
      { match: /ProcessId=112/, output: okEnvelope([null]) },
    ]);
    assert.deepEqual(result, { state: 'held', findings: [{ pid: 112, class: 'unknown' }] });
    assert.deepEqual(kills, []);
  }
  // msedgewebview2 listener with unreadable name → unknown (was: silently
  // walked the parent chain and passed the kind check).
  {
    const { result } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([113]) },
      { match: /ProcessId=113/, output: okEnvelope([{ ProcessId: 113, Name: null, CommandLine: null, ExecutablePath: null, ParentProcessId: 555 }]) },
    ]);
    assert.deepEqual(result, { state: 'held', findings: [{ pid: 113, class: 'unknown' }] });
  }
});

test('verifyCdpEndpointOwnership proves the endpoint is our browser tree before attach', () => {
  const child = hostChild(555);
  const run = (routes) => {
    const exec = fakeExec({ queries: routes });
    const api = loadIsolationModule({ exec });
    return { result: plain(api.verifyCdpEndpointOwnership(9222, child, HOST_EXE)), kills: exec.kills };
  };
  // Owned: listener is an msedgewebview2 whose parent chain reaches the
  // freshly verified host executable.
  {
    const { result } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([888]) },
      { match: /ProcessId=555/, output: hostRecord(555) },
      { match: /ProcessId=888/, output: browserRecord(888, `${SBX}\\webview-1`, { ParentProcessId: 555 }) },
    ]);
    assert.equal(result, true);
  }
  // Multi-hop chain (crashpad-style intermediate) still resolves to the host.
  {
    const { result } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([889]) },
      { match: /ProcessId=555/, output: hostRecord(555) },
      { match: /ProcessId=889/, output: browserRecord(889, `${SBX}\\webview-1`, { ParentProcessId: 900 }) },
      { match: /ProcessId=900/, output: browserRecord(900, `${SBX}\\webview-1`, { ParentProcessId: 555 }) },
    ]);
    assert.equal(result, true);
  }
  // Replaced endpoint: listener is a foreign zterm.exe → refuse.
  {
    const { result } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([777]) },
      { match: /ProcessId=555/, output: hostRecord(555) },
      { match: /ProcessId=777/, output: hostRecord(777, 'C:\\Users\\u\\zterm.exe') },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.reasons.join('; '), /not msedgewebview2/);
  }
  // Host pid metadata changed → refuse even when the listener looks right.
  {
    const { result } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([888]) },
      { match: /ProcessId=555/, output: hostRecord(555, 'C:\\Users\\u\\zterm.exe') },
      { match: /ProcessId=888/, output: browserRecord(888, `${SBX}\\webview-1`, { ParentProcessId: 555 }) },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.reasons.join('; '), /host/);
  }
  // Main's r3 counterexample: listener record with Name/ExecutablePath/
  // CommandLine null but ParentProcessId = host. Browser identity must be
  // POSITIVELY established — a missing name must not bypass the kind check.
  {
    const { result } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([889]) },
      { match: /ProcessId=555/, output: hostRecord(555) },
      { match: /ProcessId=889/, output: okEnvelope([{ ProcessId: 889, Name: null, CommandLine: null, ExecutablePath: null, ParentProcessId: 555 }]) },
    ]);
    assert.equal(result.ok, false, 'null-name listener is not positively our browser');
    assert.match(result.reasons.join('; '), /unreadable|not msedgewebview2/);
  }
  // Host executable unreadable → refuse with an explicit unknown reason.
  {
    const { result } = run([
      { match: /LocalPort -eq 9222/, output: okEnvelope([888]) },
      { match: /ProcessId=555/, output: okEnvelope([{ ProcessId: 555, Name: 'zterm.exe', CommandLine: null, ExecutablePath: null, ParentProcessId: 4 }]) },
      { match: /ProcessId=888/, output: browserRecord(888, `${SBX}\\webview-1`, { ParentProcessId: 555 }) },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.reasons.join('; '), /host pid 555.*unreadable|unreadable/);
  }
  // Listener query fails / endpoint gone → refuse (fail closed).
  assert.equal(run([{ match: /LocalPort -eq 9222/, output: errEnvelope('denied') }]).result.ok, false);
  assert.equal(run([{ match: /LocalPort -eq 9222/, output: okEnvelope([]) }]).result.ok, false);
});

test('acquireVerifiedPage throws before any CDP action when ownership is unproven', async () => {
  const order = [];
  // Unowned/replaced endpoint: discovery succeeds, verification fails → the
  // gate throws, so the caller's attach step below it never executes. Model
  // the caller exactly as e2e-check wires it: discover/verify first, connect
  // only after the gate returns.
  const runCaller = async (discoverUrl, verify) => {
    let attached = false;
    try {
      const wsUrl = await acquireVerifiedPage({
        discover: async () => { order.push('discover'); return discoverUrl; },
        expectedPort: 9222,
        verify: (port) => { order.push(`verify:${port}`); return verify(port); },
      });
      attached = true; // this line models `new Cdp(wsUrl)` — must stay unreachable on failure
      return { attached, wsUrl };
    } catch (e) {
      return { attached, error: e };
    }
  };
  const unowned = await runCaller('ws://127.0.0.1:9222/devtools/page/x', () => ({ ok: false, reasons: ['listener is zterm.exe (pid 777)'] }));
  assert.equal(unowned.attached, false, 'zero CDP actions for an unowned endpoint');
  assert.match(String(unowned.error.message), /refusing CDP attach/);
  const owned = await runCaller('ws://127.0.0.1:9222/devtools/page/x', () => true);
  assert.equal(owned.attached, true);
  assert.equal(owned.wsUrl, 'ws://127.0.0.1:9222/devtools/page/x');
});

test('acquireVerifiedPage binds its proof to the ACTUAL connection destination', async () => {
  // Main's r3 counterexample: discovery returns an endpoint on 9999 while
  // ownership verification (mocked to SUCCEED) approved the listener on the
  // expected port 9222. The gate must refuse on the destination mismatch —
  // without even consulting the (mis-scoped) verification — so the proof can
  // never approve a connection to a different target.
  let verifyCalls = 0;
  let attached = false;
  try {
    const wsUrl = await acquireVerifiedPage({
      discover: async () => 'ws://127.0.0.1:9999/devtools/page/foreign',
      expectedPort: 9222,
      verify: () => { verifyCalls++; return true; },
    });
    attached = true;
    void wsUrl;
  } catch (e) {
    assert.match(String(e.message), /refusing CDP attach/);
    assert.match(String(e.message), /9999|expected/);
  }
  assert.equal(attached, false, 'zero CDP actions for a mismatched destination');
  assert.equal(verifyCalls, 0, 'destination binding is checked before verification');
  // Non-loopback host and non-ws scheme are likewise refused.
  await assert.rejects(acquireVerifiedPage({
    discover: async () => 'ws://10.0.0.5:9222/devtools/page/x', expectedPort: 9222, verify: () => true,
  }), /refusing CDP attach/);
  await assert.rejects(acquireVerifiedPage({
    discover: async () => 'http://127.0.0.1:9222/devtools/page/x', expectedPort: 9222, verify: () => true,
  }), /refusing CDP attach/);
  await assert.rejects(acquireVerifiedPage({
    discover: async () => 'ws://127.0.0.1:9222/json/version', expectedPort: 9222, verify: () => true,
  }), /refusing CDP attach/);
  // Owned positive control: matching destination + verified owner returns the
  // endpoint for attachment.
  const wsUrl = await acquireVerifiedPage({
    discover: async () => 'ws://127.0.0.1:9222/devtools/page/abc',
    expectedPort: 9222,
    verify: (port) => (port === 9222 ? true : { ok: false, reasons: ['wrong port'] }),
  });
  assert.equal(wsUrl, 'ws://127.0.0.1:9222/devtools/page/abc');
});

test('no exported API terminates processes without per-PID ownership evidence', () => {
  // killPortHolder (kill whatever listens) and sweepDebugPortRange (kill by
  // image name) are removed for good: a stale import must surface, not run.
  assert.equal(isolation.killPortHolder, undefined);
  assert.equal(isolation.sweepDebugPortRange, undefined);
});

test('restart never replaces ownership when cleanup or port teardown failed', async () => {
  const calls = [];
  await assert.rejects(restartOwnedApp({ stop: () => false,
    waitUntilQuiet: async () => calls.push('quiet'), start: () => calls.push('start') }), /refusing restart/);
  assert.deepEqual(calls, []);
  // Incomplete-cleanup report objects must refuse the restart exactly like a
  // hard failure — an uncertain cleanup is never treated as success.
  await assert.rejects(restartOwnedApp({ stop: () => ({ ok: false, reasons: ['port 9222 still held by pid 314159 (zterm.exe) — not proven owned by this run'] }),
    waitUntilQuiet: async () => calls.push('quiet'), start: () => calls.push('start') }), /refusing restart/);
  assert.deepEqual(calls, []);
  await assert.rejects(restartOwnedApp({ stop: () => true,
    waitUntilQuiet: async () => { throw new Error('port occupied'); }, start: () => calls.push('start') }), /port occupied/);
  assert.deepEqual(calls, []);
  await restartOwnedApp({ stop: () => { calls.push('stop'); return true; },
    waitUntilQuiet: async () => calls.push('quiet'), start: () => calls.push('start') });
  assert.deepEqual(calls, ['stop', 'quiet', 'start']);
});

test('seedIsolatedConfig aborts before seeding when the anchor sets a custom dataDir', () => {
  const root = freshScratch('seed-test-');
  const source = join(root, 'source');
  mkdirSync(join(source, 'data'), { recursive: true });
  writeFileSync(join(source, 'zterm.exe'), 'test executable');
  const box = createE2eSandbox(join(source, 'zterm.exe'), root);
  const appData = join(root, 'fake-appdata');
  mkdirSync(join(appData, 'ZTerm'), { recursive: true });
  writeFileSync(join(appData, 'ZTerm', 'config.json'), JSON.stringify({ dataDir: join(root, 'real-data') }));
  assert.throws(() => seedIsolatedConfig(box, appData), /dataDir/);
  assert.equal(existsSync(join(box.directory, 'data', 'config.json')), false, 'aborted before seeding');
});

test('seedIsolatedConfig seeds an empty config and never overwrites an existing one', () => {
  const root = freshScratch('seed-test-');
  const source = join(root, 'source');
  mkdirSync(join(source, 'data'), { recursive: true });
  writeFileSync(join(source, 'zterm.exe'), 'test executable');
  const box = createE2eSandbox(join(source, 'zterm.exe'), root);
  const appData = join(root, 'fake-appdata'); // no anchor at all
  const target = seedIsolatedConfig(box, appData);
  assert.equal(readFileSync(target, 'utf8').trim(), '{}');
  writeFileSync(target, 'sentinel');
  seedIsolatedConfig(box, appData);
  assert.equal(readFileSync(target, 'utf8'), 'sentinel', 'existing config untouched');
});
