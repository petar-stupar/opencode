import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, FileSystem, Layer, Schema, Scope } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FilesystemTools } from "@opencode-ai/core/filesystem-tools"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { BuiltInTools } from "@opencode-ai/core/tool/builtins"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { toolIdentity, executeTool, toolDefinitions } from "./lib/tool"

const expected = [
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
  "directory_walk",
]
const identity = { sessionID: SessionV2.ID.make("ses_filesystem"), ...toolIdentity }

function withTools<A, E>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, ApplicationTools.Service | Scope.Scope>,
  options: { deny?: string; assertions?: PermissionV2.AssertInput[] } = {},
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* body(registry)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([BuiltInTools.node, ToolRegistry.node, ApplicationTools.node]), [
            [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(directory) }))],
            [
              PermissionV2.node,
              Layer.mock(PermissionV2.Service, {
                assert: (input) =>
                  Effect.sync(() => {
                    options.assertions?.push(input)
                  }).pipe(
                    Effect.andThen(
                      input.action === options.deny
                        ? Effect.fail(new PermissionV2.BlockedError({ rules: [] }))
                        : Effect.void,
                    ),
                  ),
              }),
            ],
            [QuestionV2.node, Layer.mock(QuestionV2.Service, { ask: () => Effect.succeed([["Yes"]]) })],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ]),
        ),
      ),
    ),
  )
}

const call = (registry: ToolRegistry.Interface, name: string, input: unknown) =>
  executeTool(registry, {
    ...identity,
    call: { type: "tool-call", id: `call-${name}`, name, input },
  })
const text = (result: Awaited<ReturnType<typeof withTools>>) => {
  if (
    !result ||
    typeof result !== "object" ||
    !("type" in result) ||
    !("value" in result) ||
    result.type !== "text" ||
    typeof result.value !== "string"
  )
    throw new Error(JSON.stringify(result))
  return result.value
}

describe("filesystem-only distribution", () => {
  test("advertises the exact catalog and cannot execute arbitrary or impersonated tools", async () => {
    await using tmp = await tmpdir()
    await withTools(tmp.path, (registry) =>
      Effect.gen(function* () {
        expect((yield* toolDefinitions(registry)).map((tool) => tool.name).sort()).toEqual([...expected].sort())
        const custom = Tool.make({
          description: "unavailable",
          input: Schema.Unknown,
          output: Schema.String,
          execute: () => Effect.die("must not run"),
        })
        const applications = yield* ApplicationTools.Service
        yield* applications.register({ bash: custom, file_read: custom })
        yield* registry.register({ shell: custom, execute: custom, mcp_remote: custom })
        expect((yield* toolDefinitions(registry)).map((tool) => tool.name).sort()).toEqual([...expected].sort())
        for (const name of [
          "bash",
          "shell",
          "execute",
          "mcp_remote",
          "task",
          "webfetch",
          "skill",
          "todowrite",
          "apply_patch",
        ])
          expect(yield* call(registry, name, {})).toEqual({ type: "error", value: `Unknown tool: ${name}` })
        const previous = yield* registry.materialize()
        yield* registry.register({ file_read: custom })
        expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).not.toContain("file_read")
        expect(
          (yield* previous.settle({
            ...identity,
            call: { type: "tool-call", id: "old", name: "file_read", input: { path: "file" } },
          })).result.type,
        ).toBe("error")
      }),
    )
  })

  test("retains question and filters mutations with the existing edit permission", async () => {
    await using tmp = await tmpdir()
    await withTools(tmp.path, (registry) =>
      Effect.gen(function* () {
        expect(
          (yield* toolDefinitions(registry, [{ action: "edit", resource: "*", effect: "deny" }]))
            .map((tool) => tool.name)
            .sort(),
        ).toEqual(["directory_walk", "file_read", "question"])
        expect(
          text(
            yield* call(registry, "question", {
              questions: [
                { question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Proceed" }] },
              ],
            }),
          ),
        ).toContain("Yes")
      }),
    )
  })

  test("creates, reads, writes, appends, renames and removes files with exact bytes", async () => {
    await using tmp = await tmpdir()
    await withTools(tmp.path, (registry) =>
      Effect.gen(function* () {
        for (const [name, input] of [
          ["file_create", { path: "file", content: "\uFEFFfirst" }],
          ["file_write", { path: "file", content: "second" }],
          ["file_append", { path: "file", content: "\nthird" }],
        ] as const)
          expect((yield* call(registry, name, input)).type).toBe("text")
        expect(JSON.parse(text(yield* call(registry, "file_read", { path: "file" })))).toMatchObject({
          content: "second\nthird",
          bytesRead: 12,
          nextOffset: 12,
          limitReached: false,
        })
        expect((yield* call(registry, "file_rename", { path: "file", destination: "renamed" })).type).toBe("text")
        expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "renamed"), "utf8"))).toBe("second\nthird")
        expect((yield* call(registry, "file_remove", { path: "renamed" })).type).toBe("text")
        expect(yield* Effect.promise(() => fs.readdir(tmp.path))).toEqual([])
      }),
    )
  })

  test("creates and renames directories and only removes empty directories", async () => {
    await using tmp = await tmpdir()
    await withTools(tmp.path, (registry) =>
      Effect.gen(function* () {
        expect((yield* call(registry, "directory_create", { path: "dir" })).type).toBe("text")
        expect((yield* call(registry, "file_create", { path: "dir/file", content: "keep" })).type).toBe("text")
        expect((yield* call(registry, "directory_remove", { path: "dir" })).type).toBe("error")
        expect((yield* call(registry, "directory_rename", { path: "dir", destination: "renamed" })).type).toBe("text")
        expect((yield* call(registry, "file_remove", { path: "renamed/file" })).type).toBe("text")
        expect((yield* call(registry, "directory_remove", { path: "renamed" })).type).toBe("text")
      }),
    )
  })

  test("does not clobber existing destinations or create missing parents", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "existing"), "keep")
    await fs.writeFile(path.join(tmp.path, "source"), "source")
    await withTools(tmp.path, (registry) =>
      Effect.gen(function* () {
        for (const [name, input] of [
          ["file_create", { path: "existing", content: "overwrite" }],
          ["file_rename", { path: "source", destination: "existing" }],
          ["file_write", { path: "missing/file", content: "new" }],
          ["directory_create", { path: "missing/nested" }],
          ["file_remove", { path: "." }],
          ["directory_remove", { path: "existing" }],
        ] as const)
          expect((yield* call(registry, name, input)).type).toBe("error")
      }),
    )
    expect(await fs.readFile(path.join(tmp.path, "existing"), "utf8")).toBe("keep")
  })

  test("validates schemas and reads bounded windows including empty files", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "file"), "abcdef")
    await fs.writeFile(path.join(tmp.path, "empty"), "")
    await fs.writeFile(path.join(tmp.path, "bom"), "\uFEFFtext")
    await withTools(tmp.path, (registry) =>
      Effect.gen(function* () {
        expect(JSON.parse(text(yield* call(registry, "file_read", { path: "file", offset: 2, limit: 3 })))).toEqual({
          content: "cde",
          bytesRead: 3,
          nextOffset: 5,
          limitReached: true,
        })
        expect(JSON.parse(text(yield* call(registry, "file_read", { path: "empty" })))).toMatchObject({
          content: "",
          bytesRead: 0,
        })
        expect(JSON.parse(text(yield* call(registry, "file_read", { path: "bom" })))).toMatchObject({
          content: "\uFEFFtext",
        })
        for (const input of [
          { path: "file", limit: 0 },
          { path: "file", offset: -1 },
          { path: "file", limit: 65537 },
        ])
          expect((yield* call(registry, "file_read", input)).type).toBe("error")
        expect((yield* call(registry, "file_write", { path: "file" })).type).toBe("error")
      }),
    )
  })

  test("follows symlinked directories, terminates cycles and includes hidden files", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "source"))
    await fs.writeFile(path.join(tmp.path, "source", ".hidden"), "source")
    await fs.symlink("source", path.join(tmp.path, "alias"), "dir")
    await fs.symlink("..", path.join(tmp.path, "source", "cycle"), "dir")
    await withTools(tmp.path, (registry) =>
      Effect.gen(function* () {
        const result = JSON.parse(text(yield* call(registry, "directory_walk", { path: ".", depth: 64 })))
        expect(result.entries).toContainEqual({ path: path.join("alias", ".hidden"), type: "file" })
        expect(result.entries).toContainEqual({ path: path.join("alias", "cycle"), type: "symlink" })
        expect(result.truncated).toBe(false)
        expect(result.entries.length).toBeLessThan(10)
        expect(JSON.parse(text(yield* call(registry, "directory_walk", { path: ".", limit: 1 }))).truncated).toBe(true)
        expect((yield* call(registry, "file_write", { path: "alias/.hidden", content: "changed" })).type).toBe("text")
      }),
    )
    expect(await fs.readFile(path.join(tmp.path, "source", ".hidden"), "utf8")).toBe("changed")
  })

  test("removes and renames symlinks without changing their targets", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "target"), "keep")
    await fs.symlink("target", path.join(tmp.path, "link"))
    await fs.symlink("missing", path.join(tmp.path, "dangling"))
    await withTools(tmp.path, (registry) =>
      Effect.gen(function* () {
        expect((yield* call(registry, "file_rename", { path: "link", destination: "renamed" })).type).toBe("text")
        expect(yield* Effect.promise(() => fs.readlink(path.join(tmp.path, "renamed")))).toBe("target")
        expect((yield* call(registry, "file_remove", { path: "renamed" })).type).toBe("text")
        expect((yield* call(registry, "file_remove", { path: "dangling" })).type).toBe("text")
      }),
    )
    expect(await fs.readFile(path.join(tmp.path, "target"), "utf8")).toBe("keep")
  })

  test("authorizes external symlinks and both rename endpoints before mutation", async () => {
    await using tmp = await tmpdir()
    await using external = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "source"), "keep")
    await fs.writeFile(path.join(external.path, "target"), "external")
    await fs.symlink(external.path, path.join(tmp.path, "external"), "dir")
    const assertions: PermissionV2.AssertInput[] = []
    await withTools(
      tmp.path,
      (registry) =>
        Effect.gen(function* () {
          expect((yield* call(registry, "file_write", { path: "external/target", content: "changed" })).type).toBe(
            "error",
          )
          expect((yield* call(registry, "directory_walk", { path: ".", depth: 4 })).type).toBe("error")
          expect(
            (yield* call(registry, "file_rename", { path: "source", destination: path.join(external.path, "renamed") }))
              .type,
          ).toBe("error")
        }),
      { deny: "external_directory", assertions },
    )
    expect(assertions.filter((input) => input.action === "external_directory")).toHaveLength(3)
    expect(await fs.readFile(path.join(external.path, "target"), "utf8")).toBe("external")
    expect(await fs.readFile(path.join(tmp.path, "source"), "utf8")).toBe("keep")
  })

  test("denied edit leaves data unchanged and denies relative escapes", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "file"), "keep")
    await withTools(
      tmp.path,
      (registry) =>
        Effect.gen(function* () {
          for (const [name, input] of [
            ["file_write", { path: "file", content: "change" }],
            ["file_append", { path: "file", content: "change" }],
            ["file_remove", { path: "file" }],
            ["file_read", { path: "../escape" }],
          ] as const)
            expect((yield* call(registry, name, input)).type).toBe("error")
        }),
      { deny: "edit" },
    )
    expect(await fs.readFile(path.join(tmp.path, "file"), "utf8")).toBe("keep")
  })
})

test("virtual-file I/O ignores reported size and never reads before writing", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "control")
  await fs.writeFile(file, "response")
  await Effect.runPromise(
    Effect.gen(function* () {
      const native = yield* FSUtil.Service
      const opens: string[] = []
      const reads: number[] = []
      const virtual: FSUtil.Interface = {
        ...native,
        stat: (path) => native.stat(path).pipe(Effect.map((stat) => ({ ...stat, size: FileSystem.Size(0) }))),
        readFile: () => Effect.die("must not read contents before a write"),
        readFileString: () => Effect.die("must not read contents before a write"),
        open: (path, options) =>
          native.open(path, options).pipe(
            Effect.map((file) => {
              opens.push(path)
              return {
                ...file,
                readAlloc: (size) => {
                  reads.push(Number(size))
                  return file.readAlloc(size)
                },
              }
            }),
          ),
      }
      const target = { canonical: file, resource: "control" }
      expect(JSON.parse(yield* FilesystemTools.execute(virtual, "file_read", { path: file }, target)).content).toBe(
        "response",
      )
      expect(opens).toEqual([file])
      expect(reads).toEqual([65536])
      yield* FilesystemTools.execute(virtual, "file_write", { path: file, content: "command\n" }, target)
      yield* FilesystemTools.execute(virtual, "file_append", { path: file, content: "next" }, target)
      expect(yield* native.readFileString(file)).toBe("command\nnext")
    }).pipe(Effect.provide(LayerNode.compile(FSUtil.node))),
  )
})
