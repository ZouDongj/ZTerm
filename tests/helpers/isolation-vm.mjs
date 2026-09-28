// VM harness for the REAL scripts/e2e-isolation.mjs (batch 05), following the
// renderer-vm.mjs philosophy: the module under test is the real source, faked
// is only the process boundary. execFileSync is replaced by a recording fake
// that answers with RAW tool outputs (stdout text / thrown errors) supplied
// per test — never with a safety verdict. Every ownership decision is
// therefore made by the real classification code.
//
// The module is loaded by stripping its ESM import/export statements (they
// cannot appear in a vm Script) and providing the imported identifiers in the
// context: real node:fs/node:path/node:url functions, a stub process, and the
// fake execFileSync. import.meta.url is rewritten to the source path so
// E2E_TMP_ROOT still resolves.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

export function loadIsolationModule({ exec, sourcePath } = {}) {
  const resolvedPath = sourcePath ?? fileURLToPath(new URL('../../scripts/e2e-isolation.mjs', import.meta.url));
  const source = readFileSync(resolvedPath, 'utf8');
  const exportedNames = [...source.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]);
  if (exportedNames.length === 0) throw new Error('no exports found — source transform is broken');
  const stripped = source
    .replace(/^import[^\n]*from[^\n]*\n/gm, '')
    .replace(/^export /gm, '')
    // The real module sees import.meta.url as a file:// URL; give the VM the
    // equivalent so fileURLToPath resolves identically.
    .replace(/import\.meta\.url/g, JSON.stringify(pathToFileURL(resolvedPath).href));
  const context = {
    copyFileSync: fs.copyFileSync, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync,
    mkdtempSync: fs.mkdtempSync, readdirSync: fs.readdirSync, readFileSync: fs.readFileSync,
    rmSync: fs.rmSync, statSync: fs.statSync, writeFileSync: fs.writeFileSync,
    dirname, join, resolve,
    fileURLToPath,
    URL,
    execFileSync: exec,
    process: { on() {}, env: {} },
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  return vm.runInContext(`${stripped}\n;({ ${exportedNames.join(', ')} })`, context, { filename: 'e2e-isolation.mjs' });
}

// Recording fake for execFileSync. `routes` is a list of { match, output } in
// priority order; `match` is tested against "<command> <args joined>". An
// output of { throw, stdout } simulates a failing command (stdout attached to
// the error, like node does for execFileSync); a function output is evaluated
// per call (stateful environments); anything else is returned as stdout
// verbatim. taskkill.exe calls are always recorded in fake.kills (fake.calls
// keeps the full argv so tests can tell /T tree kills from browser kills) and
// answer '' by default (routes.taskkill may override, e.g. to make a kill
// fail). Unrouted queries throw — tests must state the environment they need.
export function fakeExec(routes = {}) {
  const kills = [];
  const calls = [];
  const fake = (command, args) => {
    const argv = Array.isArray(args) ? args : [];
    calls.push({ command, args: argv });
    const text = `${command} ${argv.join(' ')}`;
    if (/^taskkill\.exe$/i.test(command)) {
      const pid = Number.parseInt(argv[argv.indexOf('/PID') + 1], 10);
      kills.push(pid);
      return routes.taskkill ? routes.taskkill(pid) : '';
    }
    for (const route of routes.queries ?? []) {
      if (route.match.test(text)) {
        const value = typeof route.output === 'function' ? route.output(text) : route.output;
        if (value && typeof value === 'object' && value.throw) {
          const err = new Error(value.throw);
          if ('stdout' in value) err.stdout = value.stdout;
          throw err;
        }
        return value ?? '';
      }
    }
    throw new Error(`fakeExec: no route for: ${text}`);
  };
  fake.kills = kills;
  fake.calls = calls;
  return fake;
}

// Raw stdout envelopes in the structured PowerShell protocol the module uses:
//   __ZT_OK__  + JSON payload  — the query executed; payload may be empty
//   __ZT_ERR__ + JSON message  — the query itself failed (e.g. access denied)
export const okEnvelope = (payload) => `__ZT_OK__\r\n${JSON.stringify(payload)}`;
export const errEnvelope = (message) => `__ZT_ERR__\r\n${JSON.stringify(String(message))}`;
