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

The [E2E runner](scripts/e2e-check.mjs) requires a Windows desktop session and working WebView2. It copies the tested executable into a fresh sandbox, isolates application data and the browser profile, and drives runtime interaction through the debugging protocol. A unit-test pass does not establish native UI behavior.

## Data and security

Configuration is stored as `config.json`. Debug builds default to `%APPDATA%\ZTerm`; release builds default to a `data` directory beside the executable. A custom directory selected through settings is resolved through the `dataDir` pointer in `%APPDATA%\ZTerm\config.json`. These rules are implemented by `resolve_data_dir` in [zterm.rs](src-tauri/src/zterm.rs).

Saved SSH passwords use Windows DPAPI encryption. Other configuration, including login-script text, is not covered by that password-encryption claim. Host-key fingerprints are stored separately in `%APPDATA%\ZTerm\known_hosts.json`: the first key is trusted automatically, and a changed key requires confirmation. This trust-on-first-use policy does not independently verify a server's first connection.

The Rust backend uses russh for SSH, russh-sftp for file transfer, portable-pty/ConPTY for local terminals, and arboard for the clipboard. Dependencies are declared in [Cargo.toml](src-tauri/Cargo.toml); resolved versions are in [Cargo.lock](src-tauri/Cargo.lock).

## License

MIT © 2026 zoudongjie. See [LICENSE](LICENSE). Bundled xterm.js and addon notices are in [src/vendor](src/vendor).
