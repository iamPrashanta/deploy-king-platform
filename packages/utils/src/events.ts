/**
 * Unified Platform Event Normalization
 */

export interface NormalizedEvent {
  category: "deployment" | "security" | "infra" | "compliance" | "auth";
  type: string;
  severity: "info" | "warning" | "error" | "critical";
  summary: string;
  nodeId?: string;
  siteId?: string;
  details?: Record<string, any>;
  traceId?: string;
  correlationId?: string;
}

export class EventNormalizer {
  
  /**
   * Normalizes noisy logs/alerts into a standard PlatformEvent
   */
  static normalize(raw: any): NormalizedEvent {
    // Example: Normalize a security alert
    if (raw.threatSignals) {
      return {
        category: "security",
        type: "threat.detected",
        severity: "critical",
        summary: `Security threat detected: ${raw.name} (Risk: ${raw.riskScore})`,
        nodeId: raw.nodeId,
        details: raw,
      };
    }

    // Default normalization
    return {
      category: "infra",
      type: raw.type || "system.event",
      severity: raw.severity || "info",
      summary: raw.message || "Generic system event",
      nodeId: raw.nodeId,
      details: raw,
    };
  }
}
