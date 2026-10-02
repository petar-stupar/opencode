import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Config } from "@opencode/core/config"
import { Instance } from "@opencode/core/instance"
import { buildLocationServiceMap, LocationServiceMap } from "@opencode/core/location-services"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { McpDisabled } from "@opencode/core/mcp/disabled"
import { Plugin } from "@opencode/core/plugin"
import { AbsolutePath } from "@opencode/core/schema"
import { Tool } from "@opencode/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"
import { Database } from "../src/database/database"
import { Bus } from "../src/bus"

describe("McpDisabled", () => {
  const unit = testEffect(McpDisabled.layer)

  unit.effect("keeps every catalog empty and makes add() a no-op", () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp.Service
      expect(yield* mcp.servers()).toEqual([])
      expect(yield* mcp.tools()).toEqual([])
      expect(yield* mcp.instructions()).toEqual([])
      expect(yield* mcp.prompts()).toEqual([])
      expect(yield* mcp.prompt({ server: "x", name: "p" })).toBeUndefined()
      expect(yield* mcp.resourceCatalog()).toEqual(Mcp.ResourceCatalog.make({ resources: [], templates: [] }))
      expect(yield* mcp.resources({ server: "x" })).toEqual(
        Mcp.ResourceCatalog.make({ resources: [], templates: [] }),
      )
      expect(yield* mcp.readResource({ server: "x", uri: "file:///secret" })).toBeUndefined()

      // add() only warns; it never makes a server appear in the catalog.
      yield* mcp.add("x", { type: "local", command: ["must-never-start"] })
      expect(yield* mcp.servers()).toEqual([])
      expect(yield* mcp.tools()).toEqual([])
    }),
  )

  unit.effect("fails connect, disconnect, remove, and callTool with the declared not-found error", () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp.Service
      expect(yield* mcp.connect("x").pipe(Effect.flip)).toMatchObject({ _tag: "MCP.NotFoundError", server: "x" })
      expect(yield* mcp.disconnect("x").pipe(Effect.flip)).toMatchObject({ _tag: "MCP.NotFoundError", server: "x" })
      expect(yield* mcp.remove("x").pipe(Effect.flip)).toMatchObject({ _tag: "MCP.NotFoundError", server: "x" })
      expect(yield* mcp.callTool({ server: "x", name: "tool" }).pipe(Effect.flip)).toMatchObject({
        _tag: "MCP.NotFoundError",
        server: "x",
      })
    }),
  )
})

describe("McpDisabled in a booted instance", () => {
  // A real project config that asks for a local MCP server whose command must
  // never run. The instance boots on McpDisabled, so this request never reaches
  // a real Mcp.Service and the command is never spawned.
  const configWithServer: LayerNode.Replacements = [
    Config.node.replace(
      Config.configured({
        project: false,
        global: false,
        content: JSON.stringify({
          mcp: { servers: { x: { type: "local", command: ["must-never-start"] } } },
        }),
      }),
    ),
  ]
  const bindings: LayerNode.Replacements = [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    ...configWithServer,
  ]

  const it = testEffect(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, LocationServiceMap.node]), [
      ...bindings,
      LocationServiceMap.node.replace(buildLocationServiceMap(bindings)),
    ]),
  )

  it.live("never starts the configured server or registers its tools", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const locations = yield* LocationServiceMap.Service
          const ref = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })

          yield* Effect.gen(function* () {
            const plugins = yield* Plugin.Service
            yield* plugins.awaitActivation
            const mcp = yield* Mcp.Service
            expect(yield* mcp.servers()).toEqual([])

            const registry = yield* Tool.Service
            const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
            expect(names.some((name) => name.startsWith("x_"))).toBe(false)
          }).pipe(Effect.scoped, Effect.provide(locations.get(ref)))
        }),
      ),
    ),
  )
})
