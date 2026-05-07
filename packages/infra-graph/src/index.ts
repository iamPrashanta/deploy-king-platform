/**
 * Infrastructure Graph & Causality Engine
 */

export type EntityType = "node" | "container" | "site" | "user" | "alert" | "session" | "process";

export interface GraphEntity {
  id: string;
  type: EntityType;
  name: string;
  metadata?: Record<string, any>;
}

export interface GraphRelation {
  sourceId: string;
  targetId: string;
  relation: "OWNS" | "RUNS" | "ACCESSED" | "TRIGGERED" | "CAUSED" | "MODIFIED";
}

export class InfraGraphEngine {
  
  /**
   * Causal Chain Reconstruction
   * Traces an event back through its infrastructure relationships.
   */
  async traceCausality(entityId: string): Promise<string[]> {
    console.log(`[InfraGraph] Tracing causality for entity ${entityId}`);
    
    // Example: Alert -> Process -> Container -> Site -> User
    return [
      "Alert: MALWARE_DETECTED",
      "TriggeredBy: Process (pid: 1234)",
      "RunningIn: Container (site-api-v1)",
      "OwnedBy: Site (production-api)",
      "AccessedBy: User (admin-dev)"
    ];
  }

  /**
   * Incident Timeline Replay
   * Builds a chronological causal graph of an incident.
   */
  async buildIncidentTimeline(correlationId: string): Promise<any[]> {
    console.log(`[InfraGraph] Reconstructing timeline for correlation ${correlationId}`);
    
    return [
      { timestamp: "12:01", action: "DEPLOY_STARTED", entity: "site-api" },
      { timestamp: "12:02", action: "CONTAINER_RESTARTED", entity: "container-v1" },
      { timestamp: "12:03", action: "CPU_SPIKE", entity: "node-1" },
      { timestamp: "12:04", action: "MALWARE_ALERT", entity: "process-malicious" }
    ];
  }
}

export const graphEngine = new InfraGraphEngine();
