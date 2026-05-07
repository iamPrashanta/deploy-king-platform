/**
 * AI Provider Abstraction
 */

export interface AIResponse {
  content: string;
  toolCalls?: AIToolCall[];
  raw?: any;
}

export interface AIToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AIProvider {
  id: string;
  name: string;
  chat(messages: any[], options?: any): Promise<AIResponse>;
}

/**
 * AI Intent Definition
 * AI generates structured intents, NOT raw shell commands.
 */
export interface AIIntent {
  type: string;
  target: {
    nodeId?: string;
    siteId?: string;
    containerId?: string;
  };
  action: string;
  params: Record<string, any>;
  reasoning: string;
}

export class IntelligenceEngine {
  constructor(private provider: AIProvider) {}

  async generateIntent(prompt: string, context: any): Promise<AIIntent> {
    // 1. Build system prompt with context (metrics, logs, security risks)
    // 2. Request JSON intent from provider
    // 3. Return structured intent for the Execution Broker
    console.log(`[Intelligence] Generating intent for: ${prompt}`);
    
    // Mock response for now
    return {
      type: "remediation",
      target: { nodeId: context.nodeId },
      action: "harden_ssh",
      params: { disableRoot: true },
      reasoning: "Node reported root SSH login enabled which violates security policy SSH_ROOT_DISABLED."
    };
  }
}
