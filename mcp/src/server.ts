import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TriexClientError, TriexError } from '@trinaryex/sdk'
import type { RequestContext } from './context.js'
import { preparedOutputShape } from './prepare.js'
import { fail } from './result.js'
import { toolsForMode } from './registry.js'
import { packageVersion } from './version.js'

/**
 * Refuse a call naming a world other than the one the request is scoped to:
 * whoever wrote the URL chose the world, and a tool argument can't leave it.
 */
function assertTenant(ctx: RequestContext, args: { tenant?: unknown }): void {
  if (ctx.tenant === undefined || args?.tenant === undefined) return
  if (String(args.tenant).trim().toLowerCase() === ctx.tenant) return
  throw new TriexClientError(
    TriexError.ValidationFailed,
    `This server is called for tenant "${ctx.tenant}"; "${String(args.tenant)}" is not available. Leave tenant out.`,
  )
}

/**
 * Build an MCP server bound to one request's context.
 *
 * In stateless HTTP mode a server instance is created per request, so the
 * caller's credentials live in this closure and nowhere else — there is no
 * shared registry a second tenant could read them out of.
 */
export function createServer(ctx: RequestContext): McpServer {
  const server = new McpServer({
    name: '@trinaryex/mcp',
    version: packageVersion(),
  })

  for (const tool of toolsForMode(ctx.config.mode)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        // Prepare tools share one envelope, so they declare it; read tools
        // return structuredContent without a declared schema.
        ...(tool.kind === 'prepare'
          ? { outputSchema: preparedOutputShape }
          : {}),
        annotations: {
          title: tool.title,
          // Both kinds are read-only with respect to the world: prepare tools
          // build bytes and submit nothing. The act boundary lives in the
          // caller, at signing time.
          readOnlyHint: true,
          openWorldHint: true,
        },
      },
      async (args: any) => {
        try {
          assertTenant(ctx, args)
          return (await tool.handler(ctx, args)) as any
        } catch (e) {
          return fail(e) as any
        }
      },
    )
  }

  return server
}
