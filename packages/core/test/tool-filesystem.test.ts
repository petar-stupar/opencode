import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { FilesystemOps } from "@opencode/core/tool/filesystem-ops"
import { FilesystemTools } from "@opencode/core/tool/plugin/filesystem"
import { Workspace } from "@opencode/core/workspace"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { location } from "./fixture/location"
import { withTempDir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { codeModeListings, executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const filesystemToolNode = makeLocationNode({
  name: "test/filesystem-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(FilesystemTools.Plugin)),
  deps: [Tool.node, FileAccess.node, FSUtil.node, Permission.node, Location.node],
})

const sessionID = Session.ID.make("ses_filesystem_tool_test")
const it = testEffect(Layer.empty)

interface Options {
  readonly deny?: string
  readonly assertions?: Permission.AssertInput[]
  readonly workspace?: boolean
}

const withTools = <A, E>(
  directory: string,
  body: (registry: Tool.Interface) => Effect.Effect<A, E>,
  options: Options = {},
) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    return yield* body(registry)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Tool.node, FileAccess.node, filesystemToolNode]), [
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(
              location({
                directory: AbsolutePath.make(directory),
                workspaceID: options.workspace ? Workspace.ID.make("wrk_filesystem") : undefined,
              }),
            ),
          ),
        ),
        Permission.node.replace(
          permissionLayer({
            assert: (input) =>
              Effect.sync(() => options.assertions?.push(input)).pipe(
                Effect.andThen(
                  input.action === options.deny
                    ? Effect.fail(
                        new Permission.BlockedError({
                          rules: [],
                          permission: input.action,
                          resources: input.resources,
                        }),
                      )
                    : Effect.void,
                ),
              ),
          }),
        ),
      ]),
    ),
  )

const call = (registry: Tool.Interface, name: string, input: unknown) =>
  executeTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: `call-${name}`, name, input } })

const status = (registry: Tool.Interface, name: string, input: unknown) =>
  call(registry, name, input).pipe(Effect.map((result) => result.status))

const text = (registry: Tool.Interface, name: string, input: unknown) =>
  call(registry, name, input).pipe(
    Effect.map((result) => {
      if (result.status !== "completed" || typeof result.output !== "string") throw new Error(JSON.stringify(result))
      return result.output
    }),
  )

const json = (registry: Tool.Interface, name: string, input: unknown) =>
  text(registry, name, input).pipe(Effect.map((value) => JSON.parse(value)))

const promise = <A>(run: () => Promise<A>) => Effect.promise(run)

/** Two temporary directories: the active Location and an external directory. */
const withExternal = <A, E, R>(body: (active: string, external: string) => Effect.Effect<A, E, R>) =>
  withTempDir((active) => withTempDir((external) => body(active.path, external.path)))

describe("FilesystemTools", () => {
  it.live("registers direct tools and a filesystem Code Mode mirror", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* withTools(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect((yield* toolDefinitions(registry)).map((tool) => tool.name).sort()).toEqual(
              [...FilesystemOps.names, "execute"].sort(),
            )
            expect((yield* registry.list()).map((tool) => tool.id).sort()).toEqual(
              [...FilesystemOps.names, ...FilesystemOps.names.map((name) => `filesystem_${name}`)].sort(),
            )
            const snapshot = yield* registry.snapshot()
            expect(
              codeModeListings(snapshot.codeModeCatalog!)
                .map((tool) => tool.path)
                .sort(),
            ).toEqual(FilesystemOps.names.map((name) => `filesystem.${name}`).sort())
            expect(yield* status(registry, "file_write", { path: "notes.txt", content: "first\n" })).toBe("completed")
            const result = yield* call(registry, "execute", {
              code: `await tools.filesystem.file_append({ path: "notes.txt", content: "second\\n" })
return JSON.parse(await tools.filesystem.file_read({ path: "notes.txt" })).content`,
            })
            expect(JSON.stringify(result)).toContain("first\\nsecond\\n")
          }),
        )
        yield* withTools(
          tmp.path,
          (registry) =>
            Effect.gen(function* () {
              expect(yield* registry.list()).toEqual([])
              expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["execute"])
            }),
          { workspace: true },
        )
      }),
    ),
  )

  it.live("filters mutations with the existing edit permission", () =>
    withTempDir((tmp) =>
      withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          expect(
            (yield* toolDefinitions(registry, [{ action: "edit", resource: "*", effect: "deny" }]))
              .map((tool) => tool.name)
              .sort(),
          ).toEqual(["directory_list", "directory_walk", "execute", "file_read"])
          const snapshot = yield* registry.snapshot([{ action: "edit", resource: "*", effect: "deny" }])
          expect(
            codeModeListings(snapshot.codeModeCatalog!)
              .map((tool) => tool.path)
              .sort(),
          ).toEqual(["filesystem.directory_list", "filesystem.directory_walk", "filesystem.file_read"])
        }),
      ),
    ),
  )

  it.live("creates, reads, writes, appends, renames and removes files with exact bytes", () =>
    withTempDir((tmp) =>
      withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          for (const [name, input] of [
            ["file_create", { path: "file", content: "\uFEFFfirst" }],
            ["file_write", { path: "file", content: "second" }],
            ["file_append", { path: "file", content: "\nthird" }],
          ] as const)
            expect(yield* status(registry, name, input)).toBe("completed")
          expect(yield* json(registry, "file_read", { path: "file" })).toMatchObject({
            content: "second\nthird",
            bytesRead: 12,
            nextOffset: 12,
            limitReached: false,
          })
          expect(yield* status(registry, "file_rename", { path: "file", destination: "renamed" })).toBe("completed")
          expect(yield* promise(() => fs.readFile(path.join(tmp.path, "renamed"), "utf8"))).toBe("second\nthird")
          expect(yield* status(registry, "file_remove", { path: "renamed" })).toBe("completed")
          expect(yield* promise(() => fs.readdir(tmp.path))).toEqual([])
        }),
      ),
    ),
  )

  it.live("creates and renames directories and only removes empty directories", () =>
    withTempDir((tmp) =>
      withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          expect(yield* status(registry, "directory_create", { path: "dir" })).toBe("completed")
          expect(yield* status(registry, "file_create", { path: "dir/file", content: "keep" })).toBe("completed")
          expect(yield* status(registry, "directory_remove", { path: "dir" })).toBe("error")
          expect(yield* status(registry, "directory_rename", { path: "dir", destination: "renamed" })).toBe("completed")
          expect(yield* status(registry, "file_remove", { path: "renamed/file" })).toBe("completed")
          expect(yield* status(registry, "directory_remove", { path: "renamed" })).toBe("completed")
          expect(yield* promise(() => fs.readdir(tmp.path))).toEqual([])
        }),
      ),
    ),
  )

  it.live("does not clobber existing destinations or create missing parents", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* promise(async () => {
          await fs.writeFile(path.join(tmp.path, "existing"), "keep")
          await fs.writeFile(path.join(tmp.path, "source"), "source")
        })
        yield* withTools(tmp.path, (registry) =>
          Effect.gen(function* () {
            for (const [name, input] of [
              ["file_create", { path: "existing", content: "overwrite" }],
              ["file_rename", { path: "source", destination: "existing" }],
              ["file_write", { path: "missing/file", content: "new" }],
              ["directory_create", { path: "missing/nested" }],
              ["file_remove", { path: "." }],
              ["directory_remove", { path: "existing" }],
            ] as const)
              expect(yield* status(registry, name, input)).toBe("error")
          }),
        )
        expect(yield* promise(() => fs.readFile(path.join(tmp.path, "existing"), "utf8"))).toBe("keep")
      }),
    ),
  )

  it.live("validates schemas and reads bounded windows including empty files", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* promise(async () => {
          await fs.writeFile(path.join(tmp.path, "file"), "abcdef")
          await fs.writeFile(path.join(tmp.path, "empty"), "")
          await fs.writeFile(path.join(tmp.path, "bom"), "\uFEFFtext")
        })
        yield* withTools(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(yield* json(registry, "file_read", { path: "file", offset: 2, limit: 3 })).toEqual({
              content: "cde",
              bytesRead: 3,
              nextOffset: 5,
              limitReached: true,
            })
            expect(yield* json(registry, "file_read", { path: "empty" })).toMatchObject({ content: "", bytesRead: 0 })
            expect(yield* json(registry, "file_read", { path: "bom" })).toMatchObject({ content: "\uFEFFtext" })
            for (const input of [
              { path: "file", limit: 0 },
              { path: "file", offset: -1 },
              { path: "file", limit: 65537 },
              { path: "" },
            ])
              expect(yield* status(registry, "file_read", input)).toBe("error")
            expect(yield* status(registry, "file_write", { path: "file" })).toBe("error")
          }),
        )
      }),
    ),
  )

  it.live("lists immediate entries with stat metadata and bounded pages", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const stat = yield* promise(async () => {
          await fs.writeFile(path.join(tmp.path, ".hidden"), "hello")
          await fs.writeFile(path.join(tmp.path, "empty"), "")
          await fs.mkdir(path.join(tmp.path, "source"))
          await fs.writeFile(path.join(tmp.path, "source", "nested"), "not listed")
          return fs.stat(path.join(tmp.path, ".hidden"))
        })
        yield* withTools(tmp.path, (registry) =>
          Effect.gen(function* () {
            const result = yield* json(registry, "directory_list", { path: ".", limit: 2 })
            expect(result).toMatchObject({ total: 3, truncated: true, nextOffset: 2 })
            expect(result.entries).toHaveLength(2)
            expect(result.entries[0]).toEqual({
              name: ".hidden",
              path: ".hidden",
              type: "file",
              size: "5",
              mtime: stat.mtime.toISOString(),
              atime: stat.atime.toISOString(),
              birthtime: stat.birthtime.toISOString(),
              dev: stat.dev,
              ino: stat.ino,
              mode: stat.mode,
              nlink: stat.nlink,
              uid: stat.uid,
              gid: stat.gid,
              rdev: stat.rdev,
              blksize: stat.blksize.toString(),
              blocks: stat.blocks,
            })
            expect(result.entries[1]).toMatchObject({ name: "empty", size: "0" })
            const last = yield* json(registry, "directory_list", { path: ".", offset: result.nextOffset })
            expect(last).toMatchObject({ total: 3, truncated: false, nextOffset: null })
            expect(last.entries).toHaveLength(1)
            expect(last.entries[0]).toMatchObject({ name: "source", type: "directory" })
            expect(yield* json(registry, "directory_list", { path: ".", offset: 3 })).toEqual({
              entries: [],
              total: 3,
              truncated: false,
              nextOffset: null,
            })
            for (const input of [
              { path: ".", offset: -1 },
              { path: ".", offset: 0.5 },
              { path: ".", limit: 0 },
              { path: ".", limit: 2001 },
              { path: "empty" },
              { path: "missing" },
            ])
              expect(yield* status(registry, "directory_list", input)).toBe("error")
          }),
        )
      }),
    ),
  )

  it.live("lists symlink target metadata without recursing and preserves broken links", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* promise(async () => {
          await fs.mkdir(path.join(tmp.path, "source"))
          await fs.writeFile(path.join(tmp.path, "source", "file"), "hello")
          await fs.symlink("source", path.join(tmp.path, "alias"), "dir")
          await fs.symlink("file", path.join(tmp.path, "source", "link"))
          await fs.symlink("missing", path.join(tmp.path, "source", "broken"))
          await fs.symlink(".", path.join(tmp.path, "source", "cycle"), "dir")
        })
        yield* withTools(tmp.path, (registry) =>
          Effect.gen(function* () {
            const result = yield* json(registry, "directory_list", { path: "alias" })
            expect(result).toMatchObject({ total: 4, truncated: false, nextOffset: null })
            expect(result.entries).toContainEqual(
              expect.objectContaining({ name: "link", type: "symlink", targetType: "file", size: "5" }),
            )
            expect(result.entries).toContainEqual(
              expect.objectContaining({ name: "cycle", type: "symlink", targetType: "directory" }),
            )
            expect(result.entries).toContainEqual({
              name: "broken",
              path: "broken",
              type: "symlink",
              error: expect.any(String),
            })
          }),
        )
      }),
    ),
  )

  it.live("authorizes directory listings and external symlink metadata as reads", () =>
    withExternal((active, external) =>
      Effect.gen(function* () {
        yield* promise(async () => {
          await fs.writeFile(path.join(external, "file"), "outside")
          await fs.symlink(path.join(external, "file"), path.join(active, "link"))
        })
        yield* withTools(active, (registry) =>
          Effect.gen(function* () {
            const result = yield* json(registry, "directory_list", { path: "." })
            expect(result.entries[0]).toMatchObject({ name: "link", type: "symlink", targetType: "file", size: "7" })
          }),
        )
        for (const deny of ["external_directory", "read"]) {
          const assertions: Permission.AssertInput[] = []
          yield* withTools(
            active,
            (registry) =>
              Effect.gen(function* () {
                expect(yield* call(registry, "directory_list", { path: "." })).toMatchObject({
                  status: "error",
                  error: { type: "permission.rejected" },
                })
                expect(
                  (yield* toolDefinitions(registry, [{ action: "read", resource: "*", effect: "deny" }])).map(
                    (tool) => tool.name,
                  ),
                ).not.toContain("directory_list")
              }),
            { deny, assertions },
          )
          expect(assertions.some((input) => input.action === deny)).toBe(true)
        }
      }),
    ),
  )

  it.live("follows symlinked directories, terminates cycles and includes hidden files", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* promise(async () => {
          await fs.mkdir(path.join(tmp.path, "source"))
          await fs.writeFile(path.join(tmp.path, "source", ".hidden"), "source")
          await fs.symlink("source", path.join(tmp.path, "alias"), "dir")
          await fs.symlink("..", path.join(tmp.path, "source", "cycle"), "dir")
        })
        yield* withTools(tmp.path, (registry) =>
          Effect.gen(function* () {
            const result = yield* json(registry, "directory_walk", { path: ".", depth: 64 })
            expect(result.entries).toContainEqual({ path: path.join("alias", ".hidden"), type: "file" })
            expect(result.entries).toContainEqual({ path: path.join("alias", "cycle"), type: "symlink" })
            expect(result.truncated).toBe(false)
            expect(result.entries.length).toBeLessThan(10)
            expect((yield* json(registry, "directory_walk", { path: ".", limit: 1 })).truncated).toBe(true)
            expect(yield* status(registry, "file_write", { path: "alias/.hidden", content: "changed" })).toBe(
              "completed",
            )
          }),
        )
        expect(yield* promise(() => fs.readFile(path.join(tmp.path, "source", ".hidden"), "utf8"))).toBe("changed")
      }),
    ),
  )

  it.live("removes and renames symlinks without changing their targets", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* promise(async () => {
          await fs.writeFile(path.join(tmp.path, "target"), "keep")
          await fs.symlink("target", path.join(tmp.path, "link"))
          await fs.symlink("missing", path.join(tmp.path, "dangling"))
        })
        yield* withTools(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(yield* status(registry, "file_rename", { path: "link", destination: "renamed" })).toBe("completed")
            expect(yield* promise(() => fs.readlink(path.join(tmp.path, "renamed")))).toBe("target")
            expect(yield* status(registry, "file_remove", { path: "renamed" })).toBe("completed")
            expect(yield* status(registry, "file_remove", { path: "dangling" })).toBe("completed")
          }),
        )
        expect(yield* promise(() => fs.readFile(path.join(tmp.path, "target"), "utf8"))).toBe("keep")
      }),
    ),
  )

  it.live("authorizes external symlinks and both rename endpoints before mutation", () =>
    withExternal((active, external) =>
      Effect.gen(function* () {
        yield* promise(async () => {
          await fs.writeFile(path.join(active, "source"), "keep")
          await fs.writeFile(path.join(external, "target"), "external")
          await fs.symlink(external, path.join(active, "external"), "dir")
        })
        const assertions: Permission.AssertInput[] = []
        yield* withTools(
          active,
          (registry) =>
            Effect.gen(function* () {
              expect(yield* status(registry, "file_write", { path: "external/target", content: "changed" })).toBe(
                "error",
              )
              expect(yield* status(registry, "directory_walk", { path: ".", depth: 4 })).toBe("error")
              expect(
                yield* status(registry, "file_rename", {
                  path: "source",
                  destination: path.join(external, "renamed"),
                }),
              ).toBe("error")
            }),
          { deny: "external_directory", assertions },
        )
        expect(assertions.filter((input) => input.action === "external_directory")).toMatchObject([
          { resources: [`${external.replaceAll("\\", "/")}/*`] },
          { resources: [`${external.replaceAll("\\", "/")}/*`] },
          { resources: [`${external.replaceAll("\\", "/")}/*`] },
        ])
        expect(assertions.some((input) => input.action === "edit")).toBe(false)
        expect(yield* promise(() => fs.readFile(path.join(external, "target"), "utf8"))).toBe("external")
        expect(yield* promise(() => fs.readFile(path.join(active, "source"), "utf8"))).toBe("keep")
      }),
    ),
  )

  it.live("denied edit leaves data unchanged and denies relative escapes", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* promise(() => fs.writeFile(path.join(tmp.path, "file"), "keep"))
        const assertions: Permission.AssertInput[] = []
        yield* withTools(
          tmp.path,
          (registry) =>
            Effect.gen(function* () {
              for (const [name, input] of [
                ["file_write", { path: "file", content: "change" }],
                ["file_append", { path: "file", content: "change" }],
                ["file_remove", { path: "file" }],
                ["file_read", { path: "../escape" }],
              ] as const)
                expect(yield* status(registry, name, input)).toBe("error")
            }),
          { deny: "edit", assertions },
        )
        // The relative escape is rejected before any permission request.
        expect(assertions.map((input) => input.action)).toEqual(["edit", "edit", "edit"])
        expect(yield* promise(() => fs.readFile(path.join(tmp.path, "file"), "utf8"))).toBe("keep")
      }),
    ),
  )
})

it.live("virtual-file I/O ignores reported size and never reads before writing", () =>
  withTempDir((tmp) =>
    Effect.gen(function* () {
      const file = path.join(tmp.path, "control")
      yield* promise(() => fs.writeFile(file, "response"))
      const native = yield* FSUtil.Service
      const opens: string[] = []
      const reads: number[] = []
      const virtual: FSUtil.Interface = {
        ...native,
        stat: (target) => native.stat(target).pipe(Effect.map((stat) => ({ ...stat, size: FileSystem.Size(0) }))),
        readFile: () => Effect.die("must not read contents before a write"),
        readFileString: () => Effect.die("must not read contents before a write"),
        open: (target, options) =>
          native.open(target, options).pipe(
            Effect.map((handle) => {
              opens.push(target)
              return {
                ...handle,
                readAlloc: (size) => {
                  reads.push(Number(size))
                  return handle.readAlloc(size)
                },
              }
            }),
          ),
      }
      const target = { canonical: file, resource: "control" }
      expect(JSON.parse(yield* FilesystemOps.execute(virtual, "file_read", { path: file }, target)).content).toBe(
        "response",
      )
      expect(opens).toEqual([file])
      expect(reads).toEqual([65536])
      yield* FilesystemOps.execute(virtual, "file_write", { path: file, content: "command\n" }, target)
      yield* FilesystemOps.execute(virtual, "file_append", { path: file, content: "next" }, target)
      expect(yield* native.readFileString(file)).toBe("command\nnext")
    }).pipe(Effect.provide(LayerNode.compile(FSUtil.node))),
  ),
)
