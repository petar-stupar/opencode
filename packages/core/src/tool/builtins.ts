export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Effect, Layer } from "effect"
import { FilesystemTool } from "./filesystem"
import { ToolRegistry } from "./registry"
import { QuestionTool } from "./question"

/** Closed toolset for the filesystem-only distribution. */
export const node = makeLocationNode({
  name: "built-in-tools",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.restrict()
    }),
  ),
  deps: [ToolRegistry.node, QuestionTool.node, FilesystemTool.node],
})
