export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Effect, Layer } from "effect"
import { FilesystemTool } from "./filesystem"
import { ToolRegistry } from "./registry"
import { EditTool } from "./edit"
import { ApplyPatchTool } from "./apply-patch"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { SkillTool } from "./skill"
import { TodoWriteTool } from "./todowrite"
import { QuestionTool } from "./question"

/** Built-ins for the filesystem-oriented distribution; MCP, shell and web remain disabled. */
export const node = makeLocationNode({
  name: "built-in-tools",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.restrict()
    }),
  ),
  deps: [
    ToolRegistry.node,
    EditTool.node,
    ApplyPatchTool.node,
    GlobTool.node,
    GrepTool.node,
    SkillTool.node,
    TodoWriteTool.node,
    QuestionTool.node,
    FilesystemTool.node,
  ],
})
