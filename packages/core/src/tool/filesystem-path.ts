/**
 * Path resolution for the direct filesystem tools. Relative paths must stay
 * inside the active Location; absolute paths and symlinks whose canonical
 * target leaves the Location's canonical directory carry an
 * `external_directory` authorization boundary instead of being rejected.
 */
export * as FilesystemPath from "./filesystem-path.js"

import path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { FileAccess } from "../file-access.js"
import { Project } from "../project.js"
import { AbsolutePath } from "../schema.js"

export type Kind = FileAccess.Kind

export interface ResolveInput {
  readonly path: string
  /** Selects the external approval boundary; it does not validate the target type. */
  readonly kind?: Kind
  /** Resolve only the parent for unlink/rename, so a symlink itself is the target. Defaults to true. */
  readonly followSymlinks?: boolean
}

export class PathError extends Schema.TaggedError<PathError>()("FilesystemPath.PathError", {
  path: Schema.String,
  reason: Schema.Literals(["relative_escape", "non_directory_ancestor"]),
}) {
  override get message() {
    return this.reason === "relative_escape"
      ? `Relative path escapes the working directory: ${this.path}`
      : `Path has a non-directory ancestor: ${this.path}`
  }
}

/** Structurally a `FileAccess.Target`, so it can be passed to `FileAccess.authorizeExternal`. */
export interface Target extends FileAccess.Target {
  /** Canonical existing path, or a missing path below a canonical directory. */
  readonly canonical: string
}

export interface Interface {
  readonly resolve: (input: ResolveInput) => Effect.Effect<Target, PathError | FSUtil.Error>
}

const slash = (value: string) => value.replaceAll("\\", "/")

export const make = Effect.fn("FilesystemPath.make")(function* (fs: FSUtil.Interface, directory: string) {
  const root = yield* fs.realPath(directory)

  const notFound = <A>(effect: Effect.Effect<A, FSUtil.Error>) =>
    effect.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined))

  const canonicalize = Effect.fnUntraced(function* (absolute: string) {
    const existing = yield* notFound(fs.realPath(absolute))
    if (existing !== undefined) {
      const info = yield* fs.stat(existing)
      return {
        canonical: existing,
        type: info.type,
        directory: info.type === "Directory" ? existing : path.dirname(existing),
      }
    }
    // Walk up to the nearest existing ancestor; a missing path is canonical below it.
    const anchor = yield* nearest(path.dirname(absolute))
    if (anchor === undefined) return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
    if ((yield* fs.stat(anchor.canonical)).type !== "Directory")
      return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
    return {
      canonical: path.resolve(anchor.canonical, path.relative(anchor.lexical, absolute)),
      type: undefined,
      directory: anchor.canonical,
    }
  })

  const nearest = (lexical: string): Effect.Effect<{ lexical: string; canonical: string } | undefined, FSUtil.Error> =>
    notFound(fs.realPath(lexical)).pipe(
      Effect.flatMap((canonical) => {
        if (canonical !== undefined) return Effect.succeed({ lexical, canonical })
        const parent = path.dirname(lexical)
        return parent === lexical ? Effect.undefined : nearest(parent)
      }),
    )

  const resolve = Effect.fn("FilesystemPath.resolve")(function* (input: ResolveInput) {
    const absolute = FileAccess.resolvePath(directory, input.path)
    // `~` and absolute inputs are explicit; only plain relative paths are confined lexically.
    const relative =
      !path.isAbsolute(FSUtil.windowsPath(input.path)) && path.resolve(directory, input.path) === absolute
    const lexicallyInternal = FSUtil.contains(directory, absolute)
    if (relative && !lexicallyInternal) return yield* new PathError({ path: input.path, reason: "relative_escape" })

    const resolved =
      input.followSymlinks === false
        ? yield* fs.realPath(path.dirname(absolute)).pipe(
            Effect.map((parent) => ({
              canonical: path.join(parent, path.basename(absolute)),
              type: undefined,
              directory: parent,
            })),
          )
        : yield* canonicalize(absolute)

    const external = !lexicallyInternal || !FSUtil.contains(root, resolved.canonical)
    const target = {
      canonical: resolved.canonical,
      absolute: AbsolutePath.make(absolute),
      resource: external ? slash(resolved.canonical) : slash(path.relative(root, resolved.canonical) || "."),
    }
    if (!external) return target satisfies Target
    const boundary = AbsolutePath.make(
      input.kind === "directory" && resolved.type === "Directory" ? resolved.canonical : resolved.directory,
    )
    return {
      ...target,
      externalDirectory: {
        action: "external_directory",
        directory: boundary,
        resource: slash(path.join(boundary, "*")),
        save: slash(path.join((yield* Project.root(fs, boundary)) ?? boundary, "*")),
      },
    } satisfies Target
  })

  return { resolve } satisfies Interface
})
