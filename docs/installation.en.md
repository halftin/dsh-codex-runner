# Installation and environment

[Project home](../README.en.md) · [Documentation](README.en.md) · [中文](installation.md)

This candidate is prepared locally and has not been published. Use a locally packed archive now; npm and Git tag examples below apply only after the corresponding release is published. Current-source offline verification passed 41/41 on Node 24.22.2. Older host and Node-version acceptance below is historical evidence, not a new full candidate acceptance.

## Supported environment

The `0.5.3-beta` candidate supports **Windows only**. The plugin requires Node `>=22.23.4` and DSH `>=0.2.1-rc.3 <0.3.0`, and requires an authenticated Codex CLI. Offline regression passes on Node 20.20.2, 22.23.4, and 24.19.0. Real DSH 0.2.1-rc.3 Web profile installation, settings persistence, background-run queries after restart, cancellation, and uninstall pass on Node 22.23.4 and 24.19.0. **This DSH CLI gates its entry point on `import.meta.main`; on Node 20.20.2 it exits without executing commands. Passing offline plugin tests on Node 20 does not establish host compatibility. Use the tested Node 22.23.4 or 24.19.0 for this host.** The third-party host was not patched to bypass this limitation.

Package/browser acceptance uses a deterministic model and simulated Codex. Separate Node 24 tests verify real DSH and real Codex steering during execution and original-request blocking answers in Plan mode. The latest Desktop installer, other Windows machines, and every intermediate Node version have not been individually tested.

The Codex CLI baseline is `0.160.1`. The compatibility driver requires `exec --json`, `exec resume`, and `queue`; the default driver requires App Server v2. DSH model autonomy is disabled by default, so runs use the configured default tier. The optional preset policy is also off by default and marked **beta**; its task-complexity accuracy and actual quota savings have not been demonstrated

## Installation methods

Install DSH, Node, and Codex CLI first, then run `codex login` in a terminal. The plugin does not bundle Codex CLI, install it, change `PATH`, sign you in, or copy credentials

Enter `dsh-codex-runner@0.5.3-beta` in **Plugins → Add plugin**, or use a supported DSH CLI to install into the intended profile:

```text
dsh plugin --profile <profile> add dsh-codex-runner@0.5.3-beta
```

After publication, pin the version to keep prerelease tag updates from changing the installed code. A separate `npm install` step in your project is unnecessary

Run `npm pack` locally to create `dsh-codex-runner-0.5.3-beta.tgz`, then install it. Published archives will be listed in [GitHub Releases](https://github.com/halftin/dsh-codex-runner/releases):

```text
dsh plugin --profile <profile> add ./dsh-codex-runner-0.5.3-beta.tgz
dsh --profile <profile> --dump-config
```

You can also install the release tag or a fixed commit from the GitHub repository:

```text
dsh plugin --profile <profile> add github:halftin/dsh-codex-runner#v0.5.3-beta
```

The repository root contains the installable `package.json`; no build or prepare step is required. DSH activates the bundle through `dsh.bundle.patch`. Installing a dependency with bare pnpm does not necessarily activate the bundle

Desktop users can add the archive through plugin management and restart when prompted. Desktop-profile management from the CLI varies by DSH version

Run `codex_doctor()` first to inspect executable discovery, CLI capabilities, the login state, `CODEX_HOME`, and the App Server handshake. This does not start a model turn

In Advanced settings, leave **Codex executable** empty for automatic discovery, or provide the absolute path to a native Windows PE `.exe`. `.cmd`, `.bat`, `.ps1`, and renamed scripts are rejected. Leave **Codex home** empty to inherit `CODEX_HOME`, or the CLI default if that environment variable is unset. These values affect child processes without changing the host environment or authentication files

Discovery checks the configured executable, `CODEX_EXE`, standard npm locations, `~/.local/bin`, `PATH`, and common npm-prefix, pnpm, yarn, bun, Volta, scoop, winget, user-bin, portable, and Codex Desktop locations. Windows x64 and arm64 layouts are recognized. Shell shims are inspected only for static native targets; they are not executed as a fallback

DSH must inherit the same `CODEX_HOME` used for login. Without that variable, the CLI normally uses `.codex` in the user directory. Desktop and terminal environments or service accounts may differ; configure the two paths explicitly if necessary. Never put `auth.json` in the plugin or release archive

Both drivers inherit Codex user configuration and explicitly pass the selected model, reasoning effort, approval policy, and sandbox permissions for the main task. Native subagent enablement, thread limits, default models, and reasoning settings remain owned by Codex. Native MCP servers and other extensions also follow Codex configuration

## Uninstall

Use DSH plugin management or:

```text
dsh plugin --profile <profile> remove dsh-codex-runner
```

DSH 0.2.1-rc.3 may retain the plugin's profile override and report `entry not found` after uninstall. To remove that residue, close the intended profile, back up its `cordis.patch.yml`, remove only the `id: dsh-codex-runner` override entry, and verify with `--dump-config`. The plugin does not automatically delete user settings or workspace run records
