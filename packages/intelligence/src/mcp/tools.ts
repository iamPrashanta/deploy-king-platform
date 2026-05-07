/**
 * DBBKP Model Context Protocol (MCP) Tool Definitions
 * 
 * These schemas define how an LLM can interact with the platform safely.
 */

export const PLATFORM_TOOLS = [
  {
    name: "list_nodes",
    description: "Get a list of all infrastructure nodes and their current status/health.",
    parameters: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "get_node_metrics",
    description: "Fetch real-time CPU, RAM, and Disk metrics for a specific node.",
    parameters: {
      type: "object",
      properties: {
        nodeId: { type: "string" }
      },
      required: ["nodeId"]
    }
  },
  {
    name: "analyze_security_risk",
    description: "Correlate EDR signals, FIM alerts, and network telemetry to explain a risk score.",
    parameters: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        siteId: { type: "string" }
      }
    }
  },
  {
    name: "generate_remediation_plan",
    description: "Propose a set of security hardening actions based on detected drift.",
    parameters: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        policyPack: { type: "string", enum: ["ubuntu-hardened", "hosting-safe"] }
      },
      required: ["nodeId"]
    }
  }
];
