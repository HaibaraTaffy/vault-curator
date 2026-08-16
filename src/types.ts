export interface DSVKSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  rulesPaths: string[];
  autoMode: boolean;
  scanIncludeMynote: boolean;
  scanIncludeInternet: boolean;
  scanIncludeKnowledge: boolean;
  writeChangelog: boolean;
  lastScanTime: number;
  permissionMode: "auto" | "proposal" | "normal";
  chatHistory: number;
  /** whole-vault=允许整个仓库;roots-only=仅允许 allowedWriteRoots */
  writeScope: "whole-vault" | "roots-only";
  allowedWriteRoots: string[];
  autoCompress: boolean;
  compressThreshold: number;
  keepRecent: number;
  /** 数据目录:备份/变更日志/历史存放位置 */
  dataDir: string;
  /** 一键整理的提示词模板(可自定义) */
  organizeTemplate: string;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /** 展示用元数据:工具调用日志(发送给 API 前会剥离) */
  tool_log?: { name: string; args: string; result: string; pos?: number }[];
  /** 展示用元数据:思考过程(仅 deepseek-reasoner,发送前剥离) */
  reasoning?: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  usage: ChatUsage | null;
}

export interface StreamedToolCall {
  id: string;
  name: string;
  arguments: string;
}