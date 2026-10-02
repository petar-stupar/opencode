# Filesystem-oriented OpenCode

This distribution exposes `question`, eleven direct filesystem operations, and a curated coding-agent catalog (edit/patch, glob, grep, skill, subagent, execute). Shell and web services are accessed through mounted filesystems such as terminalfs, dotnetdocfs, and webasmarkdownfs. OpenCode uses ordinary OS filesystem calls; mounting and managing 9p servers belongs to the development environment.

| Tool               | Behavior                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `question`         | Ask the user questions using the existing OpenCode question interface.                                                          |
| `file_read`        | One bounded read, without trusting file size. Returns JSON with UTF-8 `content`, `bytesRead`, `nextOffset`, and `limitReached`. |
| `file_write`       | Replace or create a file, sending exactly the supplied content.                                                                 |
| `file_append`      | Open in append mode; create a missing file.                                                                                     |
| `file_create`      | Exclusive creation; fail if the target exists.                                                                                  |
| `file_remove`      | Remove a file or symlink, without following the final symlink.                                                                  |
| `file_rename`      | Rename a file or symlink, preserving the symlink itself.                                                                        |
| `directory_create` | Create one directory; its parent must exist.                                                                                    |
| `directory_rename` | Rename a directory.                                                                                                             |
| `directory_remove` | Remove an empty directory.                                                                                                      |
| `directory_list`   | List immediate entries with names, types and stat metadata, without reading file contents.                                      |
| `directory_walk`   | Traverse directories, including hidden and ignored entries, following symlinks with cycle detection.                            |

Tool names use underscores for provider compatibility. Each direct operation is registered twice: as a native tool (`file_read`) and as a Code Mode tool under the `filesystem` namespace (`tools.filesystem.file_read(...)`), sharing one leaf that resolves paths, authorizes external directories, asserts `read` or `edit`, and performs exactly one filesystem operation.

Paths are relative to the active working directory or absolute. Relative `..` escapes are rejected. Absolute external paths and symlinks whose canonical target leaves the working directory carry an `external_directory` authorization boundary instead of being rejected outright. Reads, listings and traversal use the existing `read` permission; mutations use `edit`. Both rename endpoints are authorized, including the destination. Walking or listing a linked subtree checks its canonical directory before reading it; authorization failures stop the listing rather than becoming per-entry errors.

Reads default to 65,536 bytes and accept `limit` (1–65,536) and a nonnegative byte `offset`. They issue one open and one bounded read and never probe for EOF or automatically reread a control file. `limitReached` does not guarantee EOF when false: a service may return a short read. For ordinary files, continue with `nextOffset`. For virtual files, follow the service's own paging protocol. Text decoding is UTF-8; byte windows can split multibyte characters, so overlap windows at character boundaries when necessary.

Directory listing is nonrecursive, includes hidden and ignored entries, and sorts by name. It accepts `limit` (default 50, maximum 2,000) and a nonnegative entry `offset`, returning `entries`, `total`, `truncated` and `nextOffset` (`null` at the end). Pages are not a snapshot; concurrent directory changes can shift entries. Each entry includes `name`, relative `path`, `type`, `size`, `mtime`, `atime`, `birthtime`, `mode`, `uid`, `gid`, `ino`, `nlink`, `dev`, `rdev`, `blksize` and `blocks` as supplied by the filesystem service. Sizes and block sizes are decimal strings in bytes to preserve integer precision; times are ISO 8601 strings, modes are numeric stat mode bits, and unavailable fields are `null`. A symlink retains `type: "symlink"`, with `targetType` and metadata describing the target after permission checks. Broken links and failed stat calls remain visible with an `error` instead of metadata.

Traversal defaults to depth 1 and 200 entries, with maximum depth 64 and 2,000 entries. It reports `truncated` when a depth or entry bound is reached. Repeated canonical directories are visited once, including cycles; descendants are reported under the first encountered path. Walk a listed subdirectory to continue. Broken symlinks remain visible. Removal of a symlink to a directory uses `file_remove`.

Writes do not read previous contents, preserve or inject BOMs, run formatters, invoke a language server, create parent directories, add newlines, or retry the operation. These properties matter for control files where a read or write may trigger an action. Append uses the filesystem's append semantics. Rename uses the OS rename operation with no copy/delete fallback across mounts; it checks that the destination is absent, which is not atomic against other processes creating that path. Filesystem tools inherit the host OS's pathname and mount semantics and are not an OS sandbox.

## Agent capabilities

Alongside the direct filesystem operations, agents in this distribution have:

- **`edit` or `patch`** for source changes, chosen per model rather than both at once: models whose id matches GPT-family naming (excluding `gpt-oss` and `gpt-4`) get `patch`; every other model gets `edit`. Both keep their upstream formatting and diagnostics behavior.
- **`glob`** and **`grep`** for targeted source search, backed directly by the ripgrep executable.
- **`skill`** to load instructions and resource listings; it does not execute skill scripts itself.
- **`subagent`** to delegate to another agent (the upstream `task` tool, renamed). Delegated agents see the same distribution catalog, filtered by their own inherited permissions.
- **`question`** to ask the user a question through the existing interface.
- **`execute`** (Code Mode) to script tool calls in a confined JavaScript runtime over every tool the session actually advertises, including the `filesystem` namespace and any custom plugin tools:

  ```js
  await tools.filesystem.file_write({ path: "notes.txt", content: "first\n" })
  await tools.filesystem.file_append({ path: "notes.txt", content: "second\n" })
  return JSON.parse(await tools.filesystem.file_read({ path: "notes.txt" })).content
  ```

  Nested tools return output text; parse JSON explicitly for `file_read`, `directory_list`, and `directory_walk`. Each call retains normal input validation, permission checks, plugin hooks, and cancellation. The interpreter provides no `fetch`, no other HTTP client, no ambient filesystem or process access, no module loading, and no timers — only `tools` reaches the outside world, and `execute` cannot call itself recursively.

This distribution has no `todowrite` and no `lsp` tool; upstream v2 does not ship them at all, so there is nothing to restore or hide. Custom plugin tools remain available under their own names, subject to the same reserved-name and permission filtering as everything else, and may themselves access processes or networks as trusted host code — the restricted built-in catalog is not an OS sandbox.

### What is removed, and how

Reserved names `bash`, `shell`, `webfetch`, `websearch`, and anything prefixed `mcp_` are dropped from `Tool.Service.snapshot` (`packages/core/src/tool.ts`) regardless of which plugin registers them, before permission filtering runs. A fixed set of built-in plugin ids — `opencode.tool.read`, `opencode.tool.write`, `opencode.tool.shell`, `opencode.tool.webfetch`, `opencode.tool.websearch`, `opencode.tools`, `opencode.tools.mcp-resources`, and `opencode.browser` — are filtered out of the internal plugin lists by id in `packages/core/src/plugin/internal.ts`'s `list()`, which also adds the filesystem plugin to the `pre` list. The upstream `pre`/`post` arrays themselves are left untouched; only the ids actually activated differ. `packages/core/src/tool/filesystem-policy.ts` owns both lists.

MCP is not merely filtered from the catalog — it is replaced at the instance level. `packages/core/src/mcp/disabled.ts` provides an inert `Mcp.Service` implementation (empty catalogs, a logged warning on `add`, `NotFoundError` on `connect`/`disconnect`/`remove`/`callTool`) that `packages/core/src/instance.ts` substitutes for the real service via `McpDisabled.replacement`. Every MCP consumer — the tool registry, session context, server routes, ACP — keeps compiling and running against the real `Mcp.Interface`, but nothing ever spawns a transport, server process, or OAuth flow, even when project config requests one. ACP rejects the request explicitly: `packages/cli/src/acp/sessions.ts` refuses a non-empty `mcpServers` list with a `mcpServers`-field error before it reaches server registration, and `packages/cli/src/acp/service.ts` advertises `mcpCapabilities: { http: false, sse: false }` at `initialize`.

Code Mode has no network access: `packages/core/src/codemode/tool.ts` builds its runtime with `extensions: []`, so the upstream `fetch` extension is never installed and `typeof fetch` is `"undefined"` inside `execute`.

The user-facing session shell (the `!cmd` escape) and command-template shell interpolation are **not** part of this restriction — they remain enabled. Only the tools an agent can call are filtered; what a human types directly into their own session shell is unaffected.

## Build and install for testing

The `filesystem-builds` workflow builds on pushes to `v2` and produces CLI archives for Linux x64, Linux arm64, macOS arm64, and Windows x64, plus an installable VS Code extension (`opencode-filesystem.vsix`). It also publishes every artifact to a rolling prerelease tagged `filesystem-latest` on the repository, so a plain `curl`/install script can fetch the latest build without a GitHub token or digging through workflow run artifacts. Prefer that tag for day-to-day testing; use the matching workflow run's artifacts when you need the archive for one specific commit.

CLI builds include the web UI and run a native `--version` smoke test plus a compiled service-lifecycle check. The extension launches the `opencode` executable on the terminal's PATH; it does not bundle the CLI.

Extract the CLI archive and put its `bin/opencode` executable (`opencode.exe` on Windows) on your PATH. Verify `opencode --version` reports the filesystem build. In VS Code, use **Extensions: Install from VSIX…** to install the extension artifact. Use the fork's CLI with this extension when testing mounted services.

To build locally with the repository's pinned Bun version:

```sh
bun install --frozen-lockfile
cd packages/cli
OPENCODE_CHANNEL=filesystem bun run script/build.ts --single --skip-install
cd ../../sdks/vscode
bun install --frozen-lockfile
bun run vsce package --no-dependencies --out opencode-filesystem.vsix
```

`--single` restricts the build to the host's own OS/arch target; `--skip-install` skips reinstalling the platform-specific `@opentui/core`/`@opencode-ai/pty` packages. The native CLI is written under `packages/cli/dist/<target>/bin/opencode` (for example `packages/cli/dist/cli-linux-x64/bin/opencode`; `opencode.exe` on Windows). Builds do not install the CLI, change existing VS Code installations, or publish to either extension marketplace. Test mounted services through the installed CLI and extension before release.

## Maintaining the fork

The single seam that defines this distribution's tool policy is `packages/core/src/tool/filesystem-policy.ts` — it owns the `reserved` name set and the `excluded` built-in plugin id set, and both `tool.ts` and `plugin/internal.ts` read from it rather than hardcoding names of their own. The direct filesystem tools live in:

- `packages/core/src/tool/plugin/filesystem.ts` — the plugin (`opencode.tool.filesystem`) that registers the native and Code Mode tool pairs, wires authorization, and pushes the filesystem system-prompt part into session hooks.
- `packages/core/src/tool/filesystem-ops.ts` — the shared I/O leaf: input schemas, descriptions, the `read`/`edit` action mapping, and the actual single-operation execution.
- `packages/core/src/tool/filesystem-path.ts` — path resolution: lexical confinement for relative paths, canonicalization through symlinks, and the `external_directory` authorization boundary for anything that resolves outside the Location's root.

Other seams:

- `packages/core/src/mcp/disabled.ts` plus its installation point in `packages/core/src/instance.ts` (`McpDisabled.replacement`).
- `packages/cli/src/acp/sessions.ts` and `packages/cli/src/acp/service.ts` for the ACP-level MCP refusal and capability advertisement.
- `packages/core/src/codemode/tool.ts`, specifically the `extensions: []` passed to `CodeMode.make` in the `runtime()` helper.
- `packages/core/test/location-layer.test.ts`, which a routine upstream merge can touch incidentally through unrelated Location-graph changes; re-run it rather than assuming an unrelated diff is safe.
- Ignored upstream suites in `packages/core/bunfig.toml` (`tool-shell`, `tool-webfetch`, `tool-websearch`, `browser-idle`) for tools and plugins this distribution never activates.

### Syncing with upstream

Upstream `v2` is a separate line from this fork's `dev` (the frozen v1 distribution, tagged `filesystem-v1`). Future upstream updates come in as merges, not re-ports:

```sh
git fetch upstream
git switch -c v2sync origin/v2
git merge upstream/v2
```

Resolve conflicts explicitly at the known seams; do not let a merge driver blindly prefer this fork's version of a shared file:

- `packages/core/src/tool.ts` — the `snapshot` filtering loop (`FilesystemPolicy.allows`).
- `packages/core/src/plugin/internal.ts` — the `list()` function's `pre`/`post` resolution (`FilesystemPolicy.plugins(...)`, plus `FilesystemTools.Plugin`'s insertion).
- `packages/core/src/instance.ts` — the `McpDisabled.replacement` substitution and any other filesystem-distribution replacements.
- `packages/core/src/codemode/tool.ts` — the `extensions: []` in the Code Mode runtime.
- `packages/core/test/location-layer.test.ts` — rerun after any Location-graph changes land.
- `packages/cli/src/acp/sessions.ts` / `packages/cli/src/acp/service.ts` — the MCP refusal and capability advertisement.

Per-sync review checklist, beyond the mechanical conflicts above:

- New `ctx.tool.transform` or `editor.add` producers anywhere upstream — confirm they don't register a reserved name or bypass `FilesystemPolicy`.
- New `CodeMode.make` call sites or new extensions added to the existing one — confirm no network-capable extension reaches `execute`.
- New `Mcp.node` consumers — confirm they tolerate the inert `McpDisabled` implementation rather than assuming a live server.
- New provider-native executable tools (model-side shell/browser/code-execution features) — these can bypass the tool catalog entirely and need their own review.
- New shell entry points (anything beyond the existing user session shell and command-template interpolation, both of which stay enabled).
- `OptimizePlugin` (`packages/core/src/plugin/optimize.ts`) gaining active tool-deleting plugins — today `OpenAIToolsPlugin`/`AnthropicToolsPlugin` delete `grep`/`glob` but are deliberately left out of the exported `Plugins` list; if a future change enables them (or adds a similar plugin that _is_ exported), confirm it doesn't delete tools this distribution depends on.

Then run the package typechecks and the suites listed in `.github/workflows/filesystem-tools.yml` (`tool-filesystem`, `filesystem-mcp-disabled`, `filesystem-catalog`, `location-layer`, `tool-question`, `tool-skill`, `tool-subagent`, `tool-edit`, `tool-patch`, `tool-execute`, `codemode` in `packages/core`, plus `packages/cli/test/acp`), and run an integration smoke test against the mounted 9p services in the development image before releasing.

Keep `.github/workflows/filesystem-tools.yml`'s explicit catalog expectations (the pinned tool-name lists mirrored in `packages/core/test/filesystem-catalog.test.ts`) in sync only when the distribution's actual contract changes, not on every merge.

## Lineage

The v1 distribution is frozen on the `dev` branch, tagged `filesystem-v1`. This document describes the v2 port, started 2026-10-02 from upstream `v2` at `41516c78c8`, which rewrote the catalog and plugin system that v1's `FilesystemPolicy`-equivalent code targeted. v2 is not a merge of v1 into the new upstream line; it reimplements the same contract (direct filesystem tools, reserved-name and plugin-id filtering, disabled MCP, network-free Code Mode) against v2's plugin, tool, and session APIs. Future upstream updates land as `git merge upstream/v2`, not further re-ports.
