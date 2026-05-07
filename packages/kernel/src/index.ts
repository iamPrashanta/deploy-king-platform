/**
 * DBBKP Infrastructure Kernel
 * 
 * Standardizes the platform operating model through unified protocols, 
 * entity schemas, and execution contracts.
 */

export type EntityType = "node" | "site" | "container" | "deployment" | "alert" | "session" | "intent" | "remediation" | "user" | "workflow";

export interface EntityRef {
  id: string; // e.g. node_123, site_456
  type: EntityType;
}

/**
 * Unified Event Schema
 */
export interface PlatformEvent {
  id: string;
  traceId: string;
  correlationId: string;

  type: string; // e.g. deployment.started, security.alert
  category: "deployment" | "security" | "infra" | "compliance" | "auth";
  
  actor?: {
    userId?: string;
    nodeId?: string;
    aiSessionId?: string;
  };

  target?: EntityRef;

  severity: "info" | "warning" | "error" | "critical";
  summary: string;
  metadata: Record<string, unknown>;
  
  timestamp: number;
}

/**
 * Unified Execution Intent
 */
export interface ExecutionIntent {
  id: string;
  traceId: string;
  
  actor: {
    userId?: string;
    aiSessionId?: string;
    system?: boolean;
  };
  
  target: EntityRef;
  action: string; // e.g. restart_workload, quarantine, rotate_secret
  params: Record<string, any>;
  
  reason: string;
  riskLevel: number; // 0-100
}

/**
 * Capability Registry
 */
export class CapabilityRegistry {
  private capabilities: Set<string> = new Set();

  register(capability: string) {
    this.capabilities.add(capability);
  }

  has(capability: string): boolean {
    return this.capabilities.has(capability);
  }

  list(): string[] {
    return Array.from(this.capabilities);
  }
}

/**
 * Unified Intelligence Context
 */
export interface OperationalContext {
  topology: any; // Graph context
  telemetry: any; // Metrics/Telemetry context
  incidents: any[]; // Recent platform events
  memory: any[]; // Retrieved episodic memory
  risk: any; // Security posture context
}
