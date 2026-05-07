import { AIProvider, AIResponse } from "@dbbkp/intelligence";

/**
 * Intelligence Gateway Service
 * 
 * Central entrypoint for all AI reasoning, provider routing, 
 * and safety governance.
 */
export class IntelligenceGateway {
  private providers: Map<string, AIProvider> = new Map();

  registerProvider(provider: AIProvider) {
    this.providers.set(provider.id, provider);
  }

  async processRequest(providerId: string, messages: any[]): Promise<AIResponse> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`AI Provider ${providerId} not found`);

    console.log(`[Intelligence:Gateway] Routing request to ${provider.name} (${provider.id})`);
    
    // 1. Context Injection (Future)
    // 2. Safety Filtering (Future)
    const response = await provider.chat(messages);
    
    return response;
  }
}

/**
 * Ollama Provider Adapter
 * Enables private, local LLM integration for secure infrastructure operations.
 */
export class OllamaProvider implements AIProvider {
  id = "ollama";
  name = "Ollama (Local AI)";

  constructor(private baseUrl: string, private model: string) {}

  async chat(messages: any[]): Promise<AIResponse> {
    console.log(`[Intelligence:Ollama] Calling ${this.baseUrl}/api/chat with model ${this.model}`);
    
    // In production, use fetch() to call the Ollama API
    // POST /api/chat { model, messages, stream: false }
    
    return {
      content: "As an AI SRE, I recommend disabling root SSH login as it is currently enabled on node-1.",
      toolCalls: []
    };
  }
}

export const aiGateway = new IntelligenceGateway();
