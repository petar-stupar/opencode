/**
 * Direct filesystem tools. Each operation is registered twice: as a native
 * provider tool (`file_read`) and as a Code Mode tool in the `filesystem`
 * namespace (`tools.filesystem.file_read(...)`). Both share one leaf that
 * resolves paths, approves external directories, asserts `read` or `edit`, and
 * then performs exactly one filesystem operation.
 */
export * as FilesystemTools from "./filesystem.js"

import { SystemPart, ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Schema } from "effect"
import { FileAccess } from "../../file-access.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"
import type { Tool } from "../../tool.js"
import { FilesystemOps } from "../filesystem-ops.js"
import { FilesystemPath } from "../filesystem-path.js"

export const namespace = "filesystem"

export const Plugin = {
  id: "opencode.tool.filesystem",
  effect: Effect.fn("FilesystemTools.Plugin")(function* (ctx: Context) {
    const fs = yield* FSUtil.Service
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    const location = yield* Location.Service
    // Explicit workspace placement has no local filesystem to operate on yet.
    if (location.workspaceID !== undefined) return
    const paths = yield* FilesystemPath.make(fs, location.directory).pipe(Effect.orDie)

    const authorize = Effect.fnUntraced(function* (
      targets: readonly FilesystemPath.Target[],
      action: string,
      context: Tool.Context,
    ) {
      yield* access.authorizeExternal(targets, context)
      yield* permission.assert({
        action,
        resources: targets.map((target) => target.resource),
        save: ["*"],
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool" as const, messageID: context.messageID, id: context.id },
      })
    })

    const execute = (name: FilesystemOps.Name) => (input: FilesystemOps.Input, context: Tool.Context) =>
      Effect.gen(function* () {
        const resolved = yield* FilesystemOps.resolve(paths, name, input)
        yield* authorize(
          resolved.destination ? [resolved.target, resolved.destination] : [resolved.target],
          FilesystemOps.action(name),
          context,
        )
        // Linked or traversed subtrees are authorized by their canonical directory before being read.
        return yield* FilesystemOps.execute(fs, name, input, resolved.target, resolved.destination, (canonical) =>
          paths
            .resolve({ path: canonical, kind: "directory" })
            .pipe(Effect.flatMap((target) => authorize([target], "read", context))),
        )
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.mapError(
          (error) => new ToolFailure({ message: `Unable to ${name} ${input.path}: ${error.message}`, error }),
        ),
      )

    const hook = (event: SessionHooks["context"]) =>
      Effect.sync(() => {
        event.system.push(SystemPart.make(FilesystemOps.prompt))
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)

    yield* ctx.tool
      .transform((editor) => {
        editor.namespace({
          name: namespace,
          description:
            "Direct filesystem operations: exact reads and writes, renames, removals, directory listings with stat metadata, and bounded traversal. Results of file_read, directory_list, and directory_walk are JSON text.",
        })
        for (const name of FilesystemOps.names) {
          const tool = {
            name,
            description: FilesystemOps.descriptions[name],
            input: FilesystemOps.inputs[name] satisfies Schema.Codec<FilesystemOps.Input>,
            output: Schema.String,
            execute: execute(name),
          }
          const action = FilesystemOps.action(name)
          editor.add({ ...tool, options: { codemode: false, permission: action } })
          editor.add({ ...tool, options: { namespace, codemode: true, permission: action } })
        }
      })
      .pipe(Effect.orDie)
  }),
}
