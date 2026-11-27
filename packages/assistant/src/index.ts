// @dbbkp/assistant: the Deploy King AI assistant. An agent loop on the Anthropic Messages API whose tools
// call the Deploy King API with a Deploy King API token. Used by `dk` (apps/cli) and the desktop app.

export type { AssistantEvent, AssistantConfig, Conversation, AssistantConversation, PlanInfo, PlanAction } from "./types";
export { createConversation, DkConversation, type ConversationDeps } from "./conversation";
export { AnthropicLlm, DEFAULT_MODEL, type LlmClient, type LlmRequest, type LlmResponse, type LlmMessage, type LlmBlock, type LlmText, type LlmToolUse, type LlmToolResult, type LlmToolDef } from "./llm";
export { HttpDkApi, ApiError, type DkApi, type ToolCallResult, type ZipUpload } from "./api";
export { SecretStore, SECRET_NAME, MASK } from "./secrets";
export { checkProject, prepareUpload, sizeText, ProjectError } from "./project";
export { TOOLS, CHANGE_TOOLS, toolDefs } from "./tools";
export { SYSTEM_PROMPT } from "./prompt";
