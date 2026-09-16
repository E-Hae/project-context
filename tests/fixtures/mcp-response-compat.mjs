import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Register this stdio server in an MCP host, call all three tools, and compare
// whether TEXT_MARKER, SUMMARY_MARKER, and STRUCTURED_MARKER reach the model.
const server = new McpServer({ name: "response-compat", version: "1.0.0" });
const payload = { marker: "STRUCTURED_MARKER", value: 42 };
const options = {
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

server.registerTool("text_only", options, async () => ({
  content: [{ type: "text", text: JSON.stringify({ marker: "TEXT_MARKER", value: 42 }) }],
}));

server.registerTool("structured_summary", options, async () => ({
  content: [{ type: "text", text: "SUMMARY_MARKER" }],
  structuredContent: payload,
}));

server.registerTool("structured_only", options, async () => ({
  content: [],
  structuredContent: payload,
}));

await server.connect(new StdioServerTransport());
