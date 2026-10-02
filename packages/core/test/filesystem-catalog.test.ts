import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Schema, type Scope } from "effect"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginInternal } from "@opencode/core/plugin/internal"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { FilesystemPolicy } from "@opencode/core/tool/filesystem-policy"
import { tmpdirScoped } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { codeModeListings, executeTool, toolDefinitions } from "./lib/tool"
import { Database } from "../src/database/database"
import { Bus } from "../src/bus"
import { Tool } from "../src/tool"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, LocationServiceMap.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
  ]),
)

const filesystem = [
  "directory_create",
  "directory_list",
  "directory_remove",
  "directory_rename",
  "directory_walk",
  "file_append",
  "file_create",
  "file_read",
  "file_remove",
  "file_rename",
  "file_write",
]

const call = (name: string, input: unknown) => ({
  sessionID: Session.ID.make("ses_filesystem_catalog"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_filesystem_catalog"),
  call: { type: "tool-call" as const, id: `call_${name}`, name, input },
})

// Boots a full Location with discovery and built-in plugin activation, then runs `body` inside it.
const inLocation = <A, E>(
  config: object | undefined,
  body: Effect.Effect<A, E, Tool.Service | Agent.Service | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped()).path
    if (config) yield* Effect.promise(() => fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify(config)))
    const locations = yield* LocationServiceMap.Service
    return yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      return yield* body
    }).pipe(Effect.scoped, Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(dir) }))))
  })

describe("filesystem distribution catalog", () => {
  it.live("exposes only the filesystem roster by default", () =>
    inLocation(
      undefined,
      Effect.gen(function* () {
        const registry = yield* Tool.Service
        const snapshot = yield* registry.snapshot()
        expect(snapshot.definitions.map((tool) => tool.name).sort()).toEqual(
          [...filesystem, "edit", "execute", "glob", "grep", "patch", "question", "skill", "subagent"].sort(),
        )
        expect(snapshot.codeModeCatalog).toBeDefined()
        expect(
          codeModeListings(snapshot.codeModeCatalog!)
            .map((tool) => tool.path)
            .sort(),
        ).toEqual(filesystem.map((name) => `filesystem.${name}`))
      }),
    ),
  )

  it.live("hides reserved and MCP names registered by any plugin", () =>
    inLocation(
      undefined,
      Effect.gen(function* () {
        const registry = yield* Tool.Service
        yield* registry.transform((editor) =>
          ["bash", "shell", "webfetch", "websearch", "mcp_x", "custom_tool"].forEach((name) =>
            editor.add({
              name,
              description: `Fake ${name}`,
              input: Schema.Struct({}),
              output: Schema.String,
              options: { codemode: false },
              execute: () => Effect.succeed({ output: name }),
            }),
          ),
        )
        const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
        expect(names).toContain("custom_tool")
        for (const name of ["bash", "shell", "webfetch", "websearch", "mcp_x"]) expect(names).not.toContain(name)
        const result = yield* executeTool(registry, call("shell", {}))
        expect(result.status).toBe("error")
        expect(JSON.stringify(result.error)).toContain('No tool named \\"shell\\"')
      }),
    ),
  )

  it.live("an edit deny hides every mutating tool but keeps read-only ones", () =>
    inLocation(
      { permissions: [{ action: "edit", resource: "*", effect: "deny" }] },
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const agent = yield* agents.get(Agent.ID.make("build"))
        const registry = yield* Tool.Service
        const names = (yield* toolDefinitions(registry, agent?.permissions)).map((tool) => tool.name)
        for (const name of [
          "edit",
          "patch",
          "file_write",
          "file_append",
          "file_create",
          "file_remove",
          "file_rename",
          "directory_create",
          "directory_rename",
          "directory_remove",
        ])
          expect(names).not.toContain(name)
        for (const name of ["file_read", "directory_list", "directory_walk", "question"]) expect(names).toContain(name)
      }),
    ),
  )

  it.live("Code Mode has no fetch", () =>
    inLocation(
      undefined,
      Effect.gen(function* () {
        const registry = yield* Tool.Service
        const result = yield* executeTool(registry, call("execute", { code: "return typeof fetch" }))
        expect(result.status).toBe("completed")
        expect(JSON.stringify(result.output)).toContain('"undefined"')
      }),
    ),
  )
})

describe("FilesystemPolicy", () => {
  it.effect("excludes only built-in plugins that exist", () =>
    Effect.sync(() => {
      for (const id of FilesystemPolicy.excluded) expect(PluginInternal.builtins).toContain(id)
      expect(PluginInternal.builtins).not.toContain("opencode.tool.filesystem")
    }),
  )

  it.effect("reserves shell, network, and MCP names", () =>
    Effect.sync(() => {
      for (const name of [...FilesystemPolicy.reserved, "mcp_x"]) expect(FilesystemPolicy.allows(name)).toBe(false)
      expect(FilesystemPolicy.allows("file_read")).toBe(true)
    }),
  )
})
