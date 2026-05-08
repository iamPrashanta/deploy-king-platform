import crypto from "node:crypto";

export type TraceContext = {
  traceId?: string;
  actorId?: string;
  tenantId?: string;
  source?: string;
  metadata?: Record<string, any>;
};

export const TraceUtils = {
  generateTraceId(): string {
    return crypto.randomUUID();
  },

  createContext(data?: Partial<TraceContext>): TraceContext {
    return {
      traceId: crypto.randomUUID(),
      actorId: data?.actorId,
      tenantId: data?.tenantId,
      source: data?.source ?? "system",
      metadata: data?.metadata ?? {},
    };
  },

  childContext(
    parent: TraceContext,
    overrides?: Partial<TraceContext>
  ): TraceContext {
    return {
      ...parent,
      ...overrides,
      traceId: crypto.randomUUID(),
    };
  },
};

export type SecurityRule = {
  id: string;
  name: string;
  severity?: "low" | "medium" | "high" | "critical";
  description?: string;
  remediation?: string;
};

export const POLICY_PACKS: Record<string, SecurityRule[]> = {
  default: [],
};

export const POSTURE_RISK_WEIGHTS: Record<string, number> = {
  malware: 100,
  suspicious_process: 70,
  reverse_shell: 95,
  weak_ssh: 40,
  open_firewall: 30,
};

export const RULES: SecurityRule[] = [];
