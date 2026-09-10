import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestContext } from './context.js'
import { fail } from './result.js'
import { toolsForMode } from './registry.js'
import { packageVersion } from './version.js'

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
          return (await tool.handler(ctx, args)) as any
        } catch (e) {
          return fail(e) as any
        }
      },
    )
  }

  return server
}
