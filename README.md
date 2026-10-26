# ZTerm

A Windows terminal with SSH management, split panes, SFTP file transfer, and a Material-You-inspired interface. Built with Tauri 2, WebView2, xterm.js, and vanilla HTML/CSS/JavaScript.

## Features

- Multi-tab local terminals with PowerShell, CMD, Git Bash, and WSL detection.
- SSH profiles and groups, password or public-key authentication, reconnect actions, and Expect/Send login scripts.
- Horizontal and vertical split panes, resizing, maximizing, and drag reordering.
- SFTP browsing, upload/download, drag-and-drop, progress, and cancellation. Follow CWD uses shell directory reports; availability depends on the remote shell integration.
- Terminal color schemes, grouped quick commands, keyword/regex highlights, and editable keyboard shortcuts.
- Smooth cursors and conservative TUI software-caret recognition.

## Tab rename integration

Tabs never follow OSC 0/1/2 window titles — a program cannot rename a tab implicitly. Tools that deliberately want to label the tab they run in (for example an AI agent on a remote host) can use the explicit opt-in channel:

```text
ESC ] 1337 ; ZTermTabName=<name> ST
```

Both terminators are accepted (`\a` BEL or `\e\\` ST). An empty value clears the tool-provided name and restores default naming:

```bash
printf '\e]1337;ZTermTabName=my-ai-task\a'   # set the tab label
printf '\e]1337;ZTermTabName=\a'             # clear it
```

The tool name is display-only: it is never written into the persisted tab name and does not survive a restart. A manual rename (double-click the tab) always wins while set; clearing the manual name falls back to the tool name. The name follows its terminal across split, unsplit, and drag-to-tab moves.

Splitting a manually renamed single tab demotes the rename onto its original pane: the tab then joins its pane names, and on that pane the manual name still outranks the tool name. Collapsing or extracting back to a single terminal restores the tab-level rename.

## Install and build

Published packages, when available, are listed on [GitHub Releases](https://github.com/ZouDongj/zterm/releases). Local verification does not establish that a matching package has been published. Windows requires WebView2; see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for runtime and MSVC setup.

For development, install stable Rust, Windows MSVC build tools, WebView2, and Node.js 22 or later (also required by the E2E runner).

```powershell
git clone https://github.com/ZouDongj/zterm.git
cd zterm
npm ci
npm run dev
```

Run npm commands from the repository root. `npm run build` creates the configured NSIS installer under `src-tauri/target/release/bundle/nsis/`; `npm run build:release` builds the release executable without packaging. Commands are defined in [package.json](package.json), and bundle settings in [tauri.conf.json](src-tauri/tauri.conf.json).

## Verification

Run `npm test` for Rust and frontend unit tests. The default pre-commit gate is `npm run verify`: unit tests, release executable build, then native UI E2E. `npm run e2e` alone uses an existing release executable.

The [E2E runner](scripts/e2e-check.mjs) requires a Windows desktop session and working WebView2. It copies the tested executable into a fresh sandbox, isolates application data, execution grants and the browser profile, and drives runtime interaction through the debugging protocol. The validated native background runtime selects its sandbox grant file; normal launches retain the account Known Folder store and all authorization checks still apply. A unit-test pass does not establish native UI behavior.

Keep the configured test virtual desktop inactive before running E2E (desktop 2 by default). The runner verifies placement and keeps its test window non-activating, including during minimize and restore checks. Missing, stale, or conflicting isolation evidence stops the run; there is no foreground fallback, and the runner does not switch the user's desktop. Normal application launches are unaffected.

## Data and security

Configuration is stored as `config.json`. Debug builds default to `%APPDATA%\ZTerm`; release builds default to a `data` directory beside the executable. A custom directory selected through settings is resolved through the `dataDir` pointer in `%APPDATA%\ZTerm\config.json`. These rules are implemented by `resolve_data_dir` in [zterm.rs](src-tauri/src/zterm.rs).

Saved SSH passwords use Windows DPAPI encryption. Other configuration, including login-script text, is not covered by that password-encryption claim. Host-key fingerprints are stored separately in `%APPDATA%\ZTerm\known_hosts.json`: the first key is trusted automatically, and a changed key requires confirmation. This trust-on-first-use policy does not independently verify a server's first connection.

Connections and settings can remain shared across Windows accounts. Shared configuration does not grant another account permission to run its startup commands: the Rust backend requires a one-use authorization for each local launch and SSH destination/startup definition. Only code-defined standard shells in the account's default directory can start without a dialog: System32 Windows PowerShell or CMD with harmless startup flags, and ProgramFiles Git Bash at `Git\bin\bash.exe` (including the resolved x86 variant) with no arguments or only `-i`, `-l`, `--login`, `-il`, or `-li`. Every other local launch requires per-launch approval and cannot be remembered, even when its definition is unchanged. Cancellation that reaches the native gate before its final launch decision prevents startup; cancellation after a process has started cannot undo commands it already ran.

An account may remember an unchanged SSH destination/startup definition; display names, fonts and other appearance settings do not affect that grant. Remembered grants are used only for SSH definitions, and legacy local grants are ignored. Their inline-hashed descriptors cover host, port, username, login scripts, `followCwd`, and credential provenance; changes to those fields require re-approval. The keyed fingerprints are sealed with CurrentUser DPAPI under the Windows Local App Data Known Folder (`ZTerm\execution-trust.v1.bin`), independently of the shared `dataDir` pointer. The file contains no plaintext launch definitions, decrypted SSH passwords, or private-key contents. Administrator launches and credentials using legacy plaintext-compatible encodings receive only one-time approval. The existing account-bound password-encryption behavior remains unchanged: sharing connection definitions does not make one account's DPAPI password decryptable by another account.

Startup verification accepts ordinary local executable and directory paths, including extended-length local DOS paths. UNC/device paths, mapped remote volumes, and paths traversing junctions, symbolic links or cloud placeholders are conservatively refused before following them; select the real local path. Custom executable files must be at most 128 MiB; they are checked for changes and pinned through spawn. Remembered SSH grants also require a regular local account-storage path. Approval does not content-bind indirect local dependencies such as DLLs or interpreter configuration files. SSH credential provenance is bound, but referenced private-key file contents are not; their integrity is a credential-management concern outside the local execution-consent boundary. Remote hosts and other referenced resources are not authenticated by this check.

The Rust backend uses russh for SSH, russh-sftp for file transfer, portable-pty/ConPTY for local terminals, and arboard for the clipboard. Dependencies are declared in [Cargo.toml](src-tauri/Cargo.toml); resolved versions are in [Cargo.lock](src-tauri/Cargo.lock).

## License

MIT © 2026 zoudongjie. See [LICENSE](LICENSE). Bundled xterm.js and addon notices are in [src/vendor](src/vendor).
