export * as FilesystemTools from "./filesystem-tools"

import path from "path"
import { Effect, Option, Schema } from "effect"
import { FSUtil } from "./fs-util"
import { LocationMutation } from "./location-mutation"

export const names = [
  "question",
  "file_read",
  "file_write",
  "file_append",
  "file_create",
  "file_remove",
  "file_rename",
  "directory_create",
  "directory_rename",
  "directory_remove",
  "directory_list",
  "directory_walk",
] as const

export const prompt = `You are a coding assistant with filesystem tools and coding workflow tools.
Use file_read, file_write, file_append, file_create, file_remove, file_rename,
directory_create, directory_rename, directory_remove, directory_list, and directory_walk for direct filesystem operations.
Use edit/apply_patch for source edits, glob/grep for targeted source search, skill to load instructions,
todowrite to track work, question to ask the user, and task/lsp/execute when present in your tool catalog.
Custom plugin tools may also be available; use only the tools actually advertised for this session.
External systems can be accessed through mounted filesystem interfaces. Discover their instructions
by listing directories and reading documentation before using control files.
Direct file writes send exactly the supplied UTF-8 content. Use these direct operations for service
control files; edit/patch may read and rewrite files, format source, and notify language servers.
Scope content searches to source directories, since reading service files may itself perform an action.
There are no built-in shell, web, or MCP tools. Use the documented mounted interfaces for those services.
Code mode orchestrates enabled tools with their existing permissions; it has no ambient host access.
Do not invent mount paths or control protocols. directory_list returns entry metadata; directory_walk traverses names.
Neither operation reads file contents.`

const Path = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "Path relative to the working directory, or an absolute path to a mounted filesystem",
})
const Destination = Schema.String.check(Schema.isMinLength(1)).annotate({ description: "New path; must not exist" })
const Content = Schema.String.annotate({ description: "Exact UTF-8 content, with no implicit newline" })
const Limit = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(65536))

export const inputs = {
  file_read: Schema.Struct({
    path: Path,
    limit: Schema.optional(Limit),
    offset: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  }),
  file_write: Schema.Struct({ path: Path, content: Content }),
  file_append: Schema.Struct({ path: Path, content: Content }),
  file_create: Schema.Struct({ path: Path, content: Content }),
  file_remove: Schema.Struct({ path: Path }),
  file_rename: Schema.Struct({ path: Path, destination: Destination }),
  directory_create: Schema.Struct({ path: Path }),
  directory_rename: Schema.Struct({ path: Path, destination: Destination }),
  directory_remove: Schema.Struct({ path: Path }),
  directory_list: Schema.Struct({
    path: Path,
    limit: Schema.optional(
      Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(2000)),
    ),
    offset: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  }),
  directory_walk: Schema.Struct({
    path: Path,
    depth: Schema.optional(
      Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(64)),
    ),
    limit: Schema.optional(
      Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(2000)),
    ),
  }),
}
export type Name = keyof typeof inputs
export type Input = {
  readonly path: string
  readonly content?: string
  readonly destination?: string
  readonly limit?: number
  readonly depth?: number
  readonly offset?: number
}

export const descriptions: Record<Name, string> = {
  file_read:
    "Read a file once from a byte offset (default zero), up to limit bytes (default 65536). Size metadata is not trusted, so zero-size virtual files work. Returns JSON containing UTF-8 content, bytesRead, nextOffset, and limitReached (not an EOF guarantee). No automatic rereads. For regular files, advance offset by bytes read to continue; for virtual files, follow the service's paging protocol. A full-size read may have more data.",
  file_write:
    "Write exact UTF-8 content, replacing a file or creating it. Does not read old content, create parent directories, format, or append a newline.",
  file_append:
    "Append exact UTF-8 content with an append-mode open. Creates a missing file; parent directory must exist. Never reads or rewrites old content.",
  file_create:
    "Create a new file with exact UTF-8 content. Fails if the path already exists. Parent directory must exist.",
  file_remove: "Remove one file. Fails for directories. Does not read its contents.",
  file_rename:
    "Rename one file. Destination must not exist; parent directory must exist. No copy/delete fallback across filesystems.",
  directory_create: "Create one directory. Parent must exist; fails if the path already exists.",
  directory_rename:
    "Rename a directory. Destination must not exist; parent must exist. No cross-filesystem copy/delete fallback.",
  directory_remove:
    "Remove an empty directory. Nonempty directories must be traversed and their children explicitly removed first.",
  directory_list:
    "List immediate directory entries, including hidden and ignored files, with name, relative path, type, size, timestamps, mode, ownership, inode, device and allocation metadata. Does not recurse or read file contents. Symlinks retain type symlink and report targetType and target metadata after permission checks. Unavailable metadata is null; missing or unreadable entries report an error. Size and block size are decimal strings in bytes; timestamps are ISO 8601. Returns JSON with entries, total, truncated and nextOffset. Default limit 200, maximum 2000; offset defaults to zero. Pages are sorted by name and are not a snapshot across calls.",
  directory_walk:
    "List a directory tree, including hidden and ignored entries, without reading files. Follows symlinks with cycle detection and permission checks for external targets. Default depth 1 and limit 200 entries. Increase depth or walk a listed subdirectory to continue. Output reports truncation.",
}

export class Error extends Schema.TaggedErrorClass<Error>()("FilesystemTools.Error", { message: Schema.String }) {}

export function action(name: string) {
  if (name === "question") return "question"
  return name === "file_read" || name === "directory_list" || name === "directory_walk" ? "read" : "edit"
}

/** Shared I/O leaves; each runtime owns its own permission context and tool representation. */
export const execute = Effect.fn("FilesystemTools.execute")(function* (
  fs: FSUtil.Interface,
  name: Name,
  input: Input,
  target: LocationMutation.Target,
  destination?: LocationMutation.Target,
  authorize?: (path: string) => Effect.Effect<void, Error>,
) {
  const directory = name.startsWith("directory_")
  const creating = name === "file_create" || name === "directory_create"
  const optional = creating || name === "file_write" || name === "file_append"
  const symlink =
    !creating && (name.endsWith("_remove") || name.endsWith("_rename"))
      ? (yield* fs.readDirectoryEntries(path.dirname(target.canonical))).some(
          (entry) => entry.name === path.basename(target.canonical) && entry.type === "symlink",
        )
      : false
  if (symlink && directory) return yield* new Error({ message: `Expected directory, found symlink: ${input.path}` })
  const info = symlink
    ? undefined
    : yield* fs
        .stat(target.canonical)
        .pipe(
          Effect.catchReason("PlatformError", "NotFound", (error) =>
            optional ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        )
  if (info && info.type !== (directory ? "Directory" : "File"))
    return yield* new Error({ message: `Expected ${directory ? "directory" : "file"}: ${input.path}` })
  if (creating && info) return yield* new Error({ message: `Path already exists: ${input.path}` })

  if (name === "file_read") {
    // One open and one bounded read: a virtual read can itself consume a response.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(target.canonical, { flag: "r" })
        if (input.offset) yield* file.seek(input.offset, "start")
        const bytes = Option.getOrElse(yield* file.readAlloc(input.limit ?? 65536), () => new Uint8Array())
        return JSON.stringify({
          content: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
          bytesRead: bytes.length,
          nextOffset: (input.offset ?? 0) + bytes.length,
          limitReached: bytes.length === (input.limit ?? 65536),
        })
      }),
    )
  }
  if (name === "directory_list") {
    const children = (yield* fs.readDirectoryEntries(target.canonical)).toSorted((a, b) => a.name.localeCompare(b.name))
    const offset = input.offset ?? 0
    const entries = yield* Effect.forEach(children.slice(offset, offset + (input.limit ?? 200)), (child) =>
      Effect.gen(function* () {
        const entry = { name: child.name, path: child.name, type: child.type }
        const absolute = path.join(target.canonical, child.name)
        const canonical = yield* (child.type === "symlink" ? fs.realPath(absolute) : Effect.succeed(absolute)).pipe(
          Effect.result,
        )
        if (canonical._tag === "Failure") return { ...entry, error: String(canonical.failure) }
        // Authorization failures stop the listing; they must not become per-entry stat errors.
        if (authorize) yield* authorize(canonical.success)
        const stat = yield* fs.stat(canonical.success).pipe(Effect.result)
        if (stat._tag === "Failure") return { ...entry, error: String(stat.failure) }
        const info = stat.success
        return {
          ...entry,
          type: child.type === "symlink" ? "symlink" : info.type.toLowerCase(),
          ...(child.type === "symlink" ? { targetType: info.type.toLowerCase() } : {}),
          size: info.size.toString(),
          mtime: Option.getOrNull(Option.map(info.mtime, (time) => time.toISOString())),
          atime: Option.getOrNull(Option.map(info.atime, (time) => time.toISOString())),
          birthtime: Option.getOrNull(Option.map(info.birthtime, (time) => time.toISOString())),
          dev: info.dev,
          ino: Option.getOrNull(info.ino),
          mode: info.mode,
          nlink: Option.getOrNull(info.nlink),
          uid: Option.getOrNull(info.uid),
          gid: Option.getOrNull(info.gid),
          rdev: Option.getOrNull(info.rdev),
          blksize: Option.getOrNull(Option.map(info.blksize, (size) => size.toString())),
          blocks: Option.getOrNull(info.blocks),
        }
      }),
    )
    const truncated = offset + entries.length < children.length
    return JSON.stringify({
      entries,
      total: children.length,
      truncated,
      nextOffset: truncated ? offset + entries.length : null,
    })
  }
  if (name === "directory_walk") {
    const entries: { path: string; type: FSUtil.DirEntry["type"] }[] = []
    const visited = new Set<string>([target.canonical])
    const state = { truncated: false }
    const visit = Effect.fnUntraced(function* (
      current: string,
      relative: string,
      depth: number,
    ): Effect.fn.Return<void, FSUtil.Error | Error> {
      const children = (yield* fs.readDirectoryEntries(current)).toSorted((a, b) => a.name.localeCompare(b.name))
      for (const child of children) {
        if (entries.length >= (input.limit ?? 200)) {
          state.truncated = true
          return
        }
        const absolute = path.join(current, child.name)
        const entry = path.join(relative, child.name)
        entries.push({ path: entry, type: child.type })
        if (child.type !== "directory" && child.type !== "symlink") continue
        const canonical = yield* fs
          .realPath(absolute)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
        if (!canonical) continue
        if (authorize) yield* authorize(canonical)
        if ((yield* fs.stat(canonical)).type !== "Directory" || visited.has(canonical)) continue
        if (depth >= (input.depth ?? 1)) {
          state.truncated = true
          continue
        }
        visited.add(canonical)
        yield* visit(canonical, entry, depth + 1)
      }
    })
    yield* visit(target.canonical, "", 1)
    return JSON.stringify({ entries, truncated: state.truncated })
  }
  if (name === "file_write" || name === "file_append" || name === "file_create") {
    if (input.content === undefined) return yield* new Error({ message: "content is required" })
    yield* fs.writeFileString(target.canonical, input.content, {
      flag: name === "file_create" ? "wx" : name === "file_append" ? "a" : "w",
    })
    return `Completed ${name}: ${target.resource}`
  }
  if (name === "directory_create") {
    yield* fs.makeDirectory(target.canonical)
    return `Created directory: ${target.resource}`
  }
  if (name === "file_remove" || name === "directory_remove") {
    yield* directory ? fs.removeDirectory(target.canonical) : fs.remove(target.canonical, { recursive: false })
    return `Removed ${directory ? "directory" : "file"}: ${target.resource}`
  }
  if (!destination) return yield* new Error({ message: "destination is required" })
  if (
    (yield* fs.readDirectoryEntries(path.dirname(destination.canonical))).some(
      (entry) => entry.name === path.basename(destination.canonical),
    )
  )
    return yield* new Error({ message: `Destination exists: ${destination.resource}` })
  yield* fs.rename(target.canonical, destination.canonical)
  return `Renamed ${target.resource} to ${destination.resource}`
})

export const resolve = Effect.fn("FilesystemTools.resolve")(function* (
  mutation: LocationMutation.Interface,
  name: Name,
  input: Input,
) {
  const kind = name.startsWith("directory_") ? "directory" : "file"
  const target = yield* mutation.resolve({
    path: input.path,
    kind,
    followSymlinks:
      name === "file_read" ||
      name === "file_write" ||
      name === "file_append" ||
      name === "directory_list" ||
      name === "directory_walk",
    allowExternalSymlinks: true,
  })
  const destination =
    input.destination === undefined
      ? undefined
      : yield* mutation.resolve({
          path: input.destination,
          kind,
          followSymlinks: false,
          allowExternalSymlinks: true,
        })
  return { target, destination }
})
