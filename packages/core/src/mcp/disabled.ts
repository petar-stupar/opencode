export * as McpDisabled from "./disabled.js"

import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Mcp } from "./index.js"

// Filesystem distribution: MCP is disabled entirely. This inert implementation keeps every MCP
// consumer (tool registry, session context, server routes, ACP) compiling and running against the
// real `Mcp.Interface` without ever starting a server, transport, or OAuth flow.
export const layer = Layer.succeed(
  Mcp.Service,
  Mcp.Service.of({
    // Plugins may still register MCP transforms at startup; with no servers there is nothing to rebuild.
    transform: () => Effect.succeed({ dispose: Effect.void }),
    reload: () => Effect.void,
    servers: () => Effect.succeed([]),
    add: () => Effect.logWarning("MCP is disabled in this distribution"),
    connect: (server) => new Mcp.NotFoundError({ server: Mcp.ServerName.make(server) }),
    disconnect: (server) => new Mcp.NotFoundError({ server: Mcp.ServerName.make(server) }),
    remove: (server) => new Mcp.NotFoundError({ server: Mcp.ServerName.make(server) }),
    tools: () => Effect.succeed([]),
    callTool: (input) => new Mcp.NotFoundError({ server: Mcp.ServerName.make(input.server) }),
    instructions: () => Effect.succeed([]),
    prompts: () => Effect.succeed([]),
    prompt: () => Effect.undefined,
    resourceCatalog: () => Effect.succeed(Mcp.ResourceCatalog.make({ resources: [], templates: [] })),
    resources: () => Effect.succeed(Mcp.ResourceCatalog.make({ resources: [], templates: [] })),
    readResource: () => Effect.undefined,
  }),
)

export const replacement: LayerNode.Replacement = Mcp.node.replace(layer)
