# Filesystem-oriented OpenCode

This distribution exposes `question`, eleven direct filesystem operations, and coding workflow tools. Shell and web services are accessed through mounted filesystems such as terminalfs, dotnetdocfs, and webasmarkdownfs. OpenCode uses ordinary OS filesystem calls; mounting and managing 9p servers belongs to the development environment.

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

Tool names use underscores for provider compatibility. Paths are relative to the active working directory or absolute. Relative `..` escapes are rejected. Absolute external paths and symlinks leading outside the working directory require `external_directory` authorization. Reads, listings and traversal use the existing `read` permission; mutations use `edit`. Both rename endpoints are authorized. Walking a linked subtree checks its canonical path before reading that directory.

Reads default to 65,536 bytes and accept `limit` (1–65,536) and a nonnegative byte `offset`. They issue one read and never probe for EOF or automatically reread a control file. `limitReached` does not guarantee EOF when false: a service may return a short read. For ordinary files, continue with `nextOffset`. For virtual files, follow the service's own paging protocol. Text decoding is UTF-8; byte windows can split multibyte characters, so overlap windows at character boundaries when necessary.

Directory listing is nonrecursive, includes hidden and ignored entries, and sorts by name. It accepts `limit` (default 200, maximum 2,000) and a nonnegative entry `offset`, returning `entries`, `total`, `truncated` and `nextOffset` (`null` at the end). Pages are not a snapshot; concurrent directory changes can shift entries. Each entry includes `name`, relative `path`, `type`, `size`, `mtime`, `atime`, `birthtime`, `mode`, `uid`, `gid`, `ino`, `nlink`, `dev`, `rdev`, `blksize` and `blocks` as supplied by the filesystem service. Sizes and block sizes are decimal strings in bytes to preserve integer precision; times are ISO 8601 strings, modes are numeric stat mode bits, and unavailable fields are `null`. A symlink retains `type: "symlink"`, with `targetType` and metadata describing the target. Every entry is authorized before returning its metadata, including external symlink targets. Broken links and failed stat calls remain visible with an `error` instead of metadata; permission denials stop the listing. The filesystem service does not currently expose `ctime`.

Traversal defaults to depth 1 and 200 entries, with maximum depth 64 and 2,000 entries. It reports `truncated` when a depth or entry bound is reached. Repeated canonical directories are visited once, including cycles; descendants are reported under the first encountered path. Walk a listed subdirectory to continue. Broken symlinks remain visible. Removal of a symlink to a directory uses `file_remove`.

Writes do not read previous contents, preserve or inject BOMs, run formatters, invoke LSP, create parent directories, add newlines, or retry the operation. These properties matter for control files where a read or write may trigger an action. Append uses the filesystem's append semantics. Rename uses the OS rename operation with no copy/delete fallback across mounts. It checks that the destination is absent; this check is not atomic against other processes creating that path. Filesystem tools inherit the host OS's pathname and mount semantics and are not an OS sandbox.

## Removed agent capabilities

The CLI/legacy runtime also exposes `edit`, `apply_patch`, `todowrite`, `skill`, `task`, `lsp`, `glob`, `grep`, custom plugin tools, and `execute`. These tools are available without experimental flags, subject to agent/session permissions. Core restores its existing `edit`, `apply_patch`, `todowrite`, `skill`, `glob`, and `grep` implementations and canonical application/Location tool registrations. Core has not yet ported upstream's task, LSP, legacy plugin discovery, or code-mode leaves; this change does not bridge Core execution through legacy sessions.

Source edit/patch tools keep their upstream behavior, including legacy formatting and LSP diagnostics. Use direct `file_*` operations for mounted control files. Glob and grep use the ripgrep executable directly. LSP starts language-server processes. The `skill` tool loads instructions and resource listings; it does not execute skill scripts itself. Todo updates persistent session checklists and the TUI sidebar. Delegated agents use the same distribution catalog, with their own inherited permissions.

`execute` runs a confined script over the same permission-filtered tools advertised to the agent, including custom plugin tools. For example:

```js
await tools.file_write({ path: "notes.txt", content: "first\n" })
await tools.file_append({ path: "notes.txt", content: "second\n" })
return JSON.parse(await tools.file_read({ path: "notes.txt" })).content
```

Nested tools return output text; parse JSON explicitly for operations such as `file_read`, `directory_list`, and `directory_walk`. Each call retains normal input validation, permission checks, plugin hooks, and cancellation. Attachments are collected outside the interpreter and returned with the execute result. The interpreter provides no ambient shell, filesystem, network, or module-loading access, and cannot recursively call `execute`.

Custom JavaScript/TypeScript tools and plugin hooks run as trusted host code and can themselves access processes or networks. The restricted built-in catalog is not an OS sandbox. Reserved names `bash`, `shell`, `webfetch`, `websearch`, and the `mcp_` prefix are excluded from both catalogs. MCP discovery, transports, and resource tools remain disabled. Legacy shell requests and command-template shell interpolation still fail explicitly, as do tool-based structured-output requests. Request JSON text or write a JSON file instead.

The repository retains independent upstream implementations and protocol helpers to limit merge churn. Keeping their source does not expose them as agent tools.

## Build and install for testing

The `filesystem-builds` workflow produces CLI archives for Linux x64, macOS arm64, and Windows x64, plus an installable VS Code extension (`opencode-filesystem.vsix`). Download artifacts from the workflow run for the commit you want to test. CLI builds include the web UI and run a native `--version` smoke test. The extension launches the `opencode` executable on the terminal's PATH; it does not bundle the CLI.

Extract the CLI archive and put its `bin/opencode` executable (`opencode.exe` on Windows) on your PATH. Verify `opencode --version` reports the filesystem build. In VS Code, use **Extensions: Install from VSIX…** to install the extension artifact. Use the fork's CLI with this extension when testing mounted services.

To build locally with the repository's pinned Bun version:

```sh
bun install --frozen-lockfile
cd packages/opencode
OPENCODE_CHANNEL=filesystem bun run build --single --skip-install
cd ../../sdks/vscode
bun install --frozen-lockfile
bun run vsce package --no-dependencies --out opencode-filesystem.vsix
```

The native CLI is written under `packages/opencode/dist`. Builds do not install the CLI, change existing VS Code installations, or publish to either extension marketplace. Test mounted services through the installed CLI and extension before release.

## Maintaining the fork

The shared filesystem operations live in `packages/core/src/filesystem-tools.ts`. Core and legacy adapters own their respective permissions and tool representations. Keep them aligned. The Core built-in catalog lives in `packages/core/src/tool/builtins.ts`; the legacy catalog lives in `packages/opencode/src/tool/registry.ts`, with an additional name check in `packages/opencode/src/session/tools.ts`.

The `filesystem-tools` CI workflow runs on pushes and pull requests. Its tests pin the exact tool catalogs, exercise filesystem operations and permissions, and test custom registrations, confined orchestration, and rejection of disabled integrations and legacy shell bypasses. Make that workflow a required branch-protection check before using automatic upstream merges. Local pulls do not run GitHub checks automatically.

For each upstream update:

1. Merge or rebase upstream `dev` into a separate integration branch. Use a short branch name without slashes, as required by this repository.
2. Resolve conflicts explicitly in the catalog, session tool assembly, MCP/ACP, prompt, and permission seams. Do not use Git merge drivers that blindly prefer this fork's files; they can silently lose upstream fixes.
3. Run the package typechecks and the tests listed in `.github/workflows/filesystem-tools.yml`.
4. Review upstream additions for new tool registration, synthetic tools, plugin execution hooks, MCP connections, shell interpolation, and provider-native executable tools.
5. Run an integration smoke test against the mounted 9p services in the development image before releasing it.

No Git setting can guarantee an arbitrary future upstream merge preserves these changes. Keep the contract tests required and review changes to the contract itself. This change does not mount or modify terminalfs, build the Docker image, or verify live 9p behavior.
