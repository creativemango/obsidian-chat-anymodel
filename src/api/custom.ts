import { requestUrl } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ContentBlock,
} from "../types";

/**
 * Sends a message to any OpenAI Chat Completions-compatible API (DeepSeek,
 * Ollama, Together, OpenRouter, etc.) via requestUrl().
 *
 * This adapter uses the /v1/chat/completions endpoint with function calling,
 * which is the most widely supported format across third-party providers.
 */
export async function sendCustomMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string
): Promise<UnifiedResponse> {
  const baseUrl = (settings.baseUrl || "http://localhost:11434").replace(/\/+$/, "");
  const model = settings.model || "deepseek-chat";
  const supportsImages = supportsImageInput(model);

  const apiMessages: Record<string, unknown>[] = [];

  // System prompt (insert at front after building all messages)
  const systemMessage = systemPrompt ? { role: "system" as const, content: systemPrompt } : null;

  // Convert unified messages to OpenAI Chat Completions format
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      apiMessages.push({ role: msg.role, content: msg.content });
    } else {
      // Content blocks: tool_use (assistant) and tool_result (user)
      const textParts: string[] = [];
      const toolCalls: Record<string, unknown>[] = [];

      // Check if any image_url blocks exist (for diagnostics)
      const hasImageBlock = msg.content.some(
        (b) => ((b as unknown) as Record<string, unknown>).type === "image_url"
      );

      for (const block of msg.content) {
        const b = (block as unknown) as Record<string, unknown>;
        switch (b.type) {
          case "text":
            if (b.text) textParts.push(b.text as string);
            break;
          case "image_url": {
            // If the model supports images, preserve the image_url;
            // otherwise, convert to a text placeholder.
            if (supportsImages) {
              textParts.push(`[Image: ${(b.image_url as Record<string, unknown>)?.url || "attached image"}]`);
            } else {
              textParts.push("[Image (not supported by this model)]");
            }
            break;
          }
          case "tool_use":
            toolCalls.push({
              id: b.id,
              type: "function",
              function: {
                name: b.name,
                arguments: JSON.stringify(b.input),
              },
            });
            break;
          case "tool_result":
            apiMessages.push({
              role: "tool",
              tool_call_id: b.tool_use_id,
              content: (b.content as string) || "",
            });
            break;
          default:
            // Unknown block type - convert to text fallback to avoid
            // breaking poorly-supported providers (e.g. DeepSeek, Ollama)
            textParts.push(`[Unsupported content: ${b.type}]`);
            break;
        }
      }

      // Build the message
      if (msg.role === "assistant") {
        const entry: Record<string, unknown> = { role: "assistant" };
        if (textParts.length > 0) {
          entry.content = textParts.join("\n");
        } else {
          entry.content = null;
        }
        if (toolCalls.length > 0) {
          entry.tool_calls = toolCalls;
        }
        apiMessages.push(entry);
      } else if (textParts.length > 0 || hasImageBlock) {
        apiMessages.push({ role: "user", content: textParts.join("") });
      }
    }
  }

  // Insert system prompt at the front
  if (systemMessage) {
    apiMessages.unshift(systemMessage);
  }

  const body: Record<string, unknown> = {
    model,
    messages: apiMessages,
    stream: false,
  };

  // Tools as OpenAI function calling format
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  let response;
  try {
    response = await requestUrl({
      url: `${baseUrl}/v1/chat/completions`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e: unknown) {
    const err = e as Record<string, unknown>;
    const apiMsg = (err.json as { error?: { message?: string } })?.error?.message;
    if (apiMsg) {
      throw new Error(`API error: ${apiMsg}`);
    }
    throw new Error(`Request failed: ${err.message || String(e)}`);
  }

  if (response.status !== 200) {
    const errorBody = response.json?.error?.message || `HTTP ${response.status}`;
    throw new Error(`API error (${response.status}): ${errorBody}`);
  }

  const data = response.json;
  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error("No response from API");
  }

  const content: ContentBlock[] = [];

  // Extract text content
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  // Extract tool/function calls
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = { _raw: tc.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  const hasToolCalls = content.some((b) => b.type === "tool_use");
  const stopReason = hasToolCalls ? "tool_use" : "end_turn";

  return {
    content,
    stopReason,
    usage: data.usage
      ? {
          inputTokens: data.usage.prompt_tokens || 0,
          outputTokens: data.usage.completion_tokens || 0,
        }
      : undefined,
  };
}

/**
 * Check if a model/API supports image_url content blocks.
 * Most OpenAI-compatible providers (DeepSeek, Ollama, Together, etc.)
 * do NOT support vision/image inputs. Only a few do.
 *
 * Override via model name: if it contains known vision-supporting keywords.
 */
function supportsImageInput(model: string): boolean {
  return /vision|vl|multimodal|gpt-4o|gpt-4\.1|claude-3\.5|claude-3\.7/i.test(model);
}

