import { isIP } from "node:net";

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
export const OLLAMA_MEMBER_MODEL_ID = "ollama:runtime";

export interface OllamaSettings {
  host: string;
  model?: string;
}

export interface OllamaDraft {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

export class OllamaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaUnavailableError";
  }
}

export class OllamaProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaProtocolError";
  }
}

export function resolveOllamaSettings(input: { host?: string; model?: string }): OllamaSettings {
  const host = input.host ?? process.env.ROOM_OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST;
  const configuredModel = input.model ?? process.env.ROOM_OLLAMA_MODEL;
  const model = configuredModel?.trim() || undefined;
  return { host, model };
}

function normalizeLocalOrigin(host: string): string {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new Error("Ollama host must be a valid local HTTP origin");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4Loopback = isIP(hostname) === 4 && Number(hostname.split(".")[0]) === 127;
  const ipv6Loopback = isIP(hostname) === 6 && hostname === "::1";
  const localName = hostname === "localhost";
  if (url.protocol !== "http:" || (!ipv4Loopback && !ipv6Loopback && !localName) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Ollama host must be a loopback HTTP origin with no path or credentials");
  }
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function requestJson(host: string, endpoint: "api/tags" | "api/generate", body?: Record<string, unknown>): Promise<unknown> {
  const origin = normalizeLocalOrigin(host);
  let response: Response;
  try {
    response = await fetch(new URL(`/${endpoint}`, origin), {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
    });
  } catch {
    throw new OllamaUnavailableError("Ollama is not reachable at the configured loopback host");
  }
  if (!response.ok) throw new OllamaUnavailableError(`Ollama returned HTTP ${response.status}`);
  try {
    return await response.json() as unknown;
  } catch {
    throw new OllamaProtocolError("Ollama returned invalid JSON");
  }
}

export async function probeOllamaModels(host: string): Promise<string[]> {
  const result = await requestJson(host, "api/tags");
  if (!isRecord(result) || !Array.isArray(result.models)) throw new OllamaProtocolError("Ollama model listing has an invalid shape");
  const models = result.models.flatMap((entry) => isRecord(entry) && typeof entry.name === "string" && entry.name.trim() ? [entry.name] : []);
  if (models.length === 0) throw new OllamaUnavailableError("Ollama is reachable but reports no available models");
  return models;
}

export function selectOllamaModel(models: string[], requested?: string): string {
  if (models.length === 0) throw new OllamaUnavailableError("Ollama reports no available models");
  if (requested !== undefined) {
    if (!models.includes(requested)) throw new OllamaUnavailableError("The configured Ollama model is not reported by the local instance");
    return requested;
  }
  return models[0]!;
}

export async function generateOllamaDraft(input: {
  host: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
}): Promise<OllamaDraft> {
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) throw new Error("Ollama output limit must be a positive safe integer");
  const result = await requestJson(input.host, "api/generate", {
    model: input.model,
    prompt: input.prompt,
    stream: false,
    options: { num_predict: input.maxOutputTokens },
  });
  if (!isRecord(result) || typeof result.response !== "string" || !result.response.trim() || result.done !== true
    || !Number.isSafeInteger(result.prompt_eval_count) || (result.prompt_eval_count as number) < 0
    || !Number.isSafeInteger(result.eval_count) || (result.eval_count as number) < 0) {
    throw new OllamaProtocolError("Ollama generation response lacks a completed draft and safe integer usage counts");
  }
  return {
    text: result.response,
    usage: {
      inputTokens: result.prompt_eval_count as number,
      outputTokens: result.eval_count as number,
    },
  };
}
