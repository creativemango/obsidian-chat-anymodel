import { App, TFile, TFolder } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  ContentBlock,
  AgentCallbacks,
  SelectionScope,
} from "../types";
import { sendMessage } from "../api/client";
import { clearOpenAIState } from "../api/openai";
import { TOOL_DEFINITIONS } from "../tools/registry";
import { executeTool } from "../tools/executor";
import { buildContext } from "./context";
import { buildSystemPrompt, buildContextMessage } from "./system-prompt";

const MAX_CONVERSATION_LENGTH = 50;
const KEEP_RECENT = 40;

// Debug logging: writes transcript to the vault's plugin config folder
const DEBUG = true;

function debugLog(app: App, label: string, data: unknown): void {
  if (!DEBUG) return;
  try {
    const timestamp = new Date().toISOString();
    const entry = `\n--- ${label} [${timestamp}] ---\n${JSON.stringify(data, null, 2)}\n`;
    // Use the adapter to write outside the vault
    app.vault.adapter.append(
      ".obsidian/plugins/obsidian-chat/debug.log",
      entry
    );
  } catch {
    // Debug logging should never break the app
  }
}

/**
 * The core agentic loop:
 * 1. Send user message + history to API
 * 2. If response contains tool_use, execute tools, append results, loop
 * 3. If response is end_turn, deliver text to user, done
 * 4. Safety: stop after maxIterations to prevent runaway loops
 */
export class AgentLoop {
  private messages: UnifiedMessage[] = [];
  private app: App;
  private settings: ChatSettings;
  private aborted = false;

  constructor(app: App, settings: ChatSettings) {
    this.app = app;
    this.settings = settings;
  }

  /** Abort a running loop (e.g. user navigates away) */
  abort(): void {
    this.aborted = true;
  }

  /** Clear conversation history */
  clear(): void {
    this.messages = [];
    this.aborted = false;
    clearOpenAIState();
  }

  /** Export API messages for persistence */
  exportMessages(): UnifiedMessage[] {
    return this.messages;
  }

  /** Restore API messages from persistence */
  importMessages(messages: UnifiedMessage[]): void {
    this.messages = sanitizeMessages(messages);
  }

  /** Export the full conversation as a readable markdown transcript */
  exportTranscript(): string {
    const systemPrompt = buildSystemPrompt();

    const parts: string[] = [
      `# Obsidian Chat Transcript`,
      ``,
      `**Date:** ${new Date().toISOString()}`,
      `**Provider:** ${this.settings.provider}`,
      `**Model:** ${this.settings.model}`,
      ``,
      `## System Prompt`,
      ``,
      "```",
      systemPrompt,
      "```",
      ``,
      `## Conversation`,
      ``,
    ];

    for (const msg of this.messages) {
      if (typeof msg.content === "string") {
        parts.push(`### ${msg.role === "user" ? "User" : "Assistant"}`);
        parts.push(``);
        parts.push(msg.content);
        parts.push(``);
      } else {
        // Content blocks
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            parts.push(`### Assistant`);
            parts.push(``);
            parts.push(block.text);
            parts.push(``);
          } else if (block.type === "tool_use") {
            parts.push(`### Tool Call: \`${block.name}\``);
            parts.push(``);
            parts.push("```json");
            parts.push(JSON.stringify(block.input, null, 2));
            parts.push("```");
            parts.push(``);
          } else if (block.type === "tool_result") {
            parts.push(`### Tool Result ${block.is_error ? "(ERROR)" : ""}`);
            parts.push(``);
            parts.push("```");
            parts.push(block.content || "(empty)");
            parts.push("```");
            parts.push(``);
          }
        }
      }
    }

    return parts.join("\n");
  }

  private async buildExternalContext(
    externalContexts: Array<{ path: string; title: string; content?: string }>
  ): Promise<string> {
    if (externalContexts.length === 0) {
      return "";
    }

    const parts: string[] = ["[External context: include the following files as additional context for the user request.]"];

    for (const ctx of externalContexts) {
      if (ctx.content && ctx.content.length > 0) {
        parts.push(`File: ${ctx.title || ctx.path}`);
        parts.push("```\n" + ctx.content.slice(0, 2000) + "\n```");
      } else {
        const file = this.app.vault.getAbstractFileByPath(ctx.path) as TFile | null;
        if (file && file instanceof TFile) {
          try {
            const content = await this.app.vault.cachedRead(file);
            parts.push(`File: ${file.path}`);
            parts.push("```\n" + content.slice(0, 2000) + "\n```");
          } catch {
            // ignore read errors
          }
        }
      }
    }

    return parts.join("\n");
  }

  private async buildMentionContext(userMessage: string): Promise<string> {
    const tokens = this.extractMentionTokens(userMessage);
    if (tokens.length === 0) {
      return "";
    }

    const parts: string[] = ["[Mention context: include the following note content as additional context for the user request.]"];

    for (const token of tokens) {
      if (token === "current") {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          try {
            const content = await this.app.vault.cachedRead(activeFile);
            parts.push(`Current file: ${activeFile.path}`);
            parts.push("```\n" + content.slice(0, 2000) + "\n```");
          } catch {
            // ignore read errors
          }
        }
      } else if (token.startsWith("folder:")) {
        const folderPath = token.slice("folder:".length);
        const folder = this.app.vault.getAbstractFileByPath(folderPath) as TFolder | null;
        if (folder && folder instanceof Object && "children" in folder) {
          parts.push(`Folder: ${folderPath}`);
          const files = this.collectMarkdownFilesInFolder(folder, 10);
          for (const file of files) {
            try {
              const content = await this.app.vault.cachedRead(file);
              parts.push(`File: ${file.path}`);
              parts.push("```\n" + content.slice(0, 1200) + "\n```");
            } catch {
              // ignore read errors
            }
          }
        }
      } else if (token.startsWith("tag:")) {
        const tagValue = token.slice("tag:".length);
        const files = this.findFilesByTag(tagValue, 10);
        if (files.length > 0) {
          parts.push(`Tag: ${tagValue}`);
          for (const file of files) {
            try {
              const content = await this.app.vault.cachedRead(file);
              parts.push(`File: ${file.path}`);
              parts.push("```\n" + content.slice(0, 1200) + "\n```");
            } catch {
              // ignore read errors
            }
          }
        }
      }
    }

    return parts.join("\n");
  }

  private extractMentionTokens(text: string): string[] {
    const tokens: string[] = [];
    const regex = /@current|@folder:([^\s]+)|@tag:([^\s]+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match[0] === "@current") {
        tokens.push("current");
      } else if (match[1]) {
        tokens.push(`folder:${match[1]}`);
      } else if (match[2]) {
        tokens.push(`tag:${match[2]}`);
      }
    }
    return tokens;
  }

  private collectMarkdownFilesInFolder(folder: TFolder, limit: number): TFile[] {
    const results: TFile[] = [];
    const collect = (f: TFolder): void => {
      for (const child of f.children) {
        if (child instanceof TFile && child.extension === "md") {
          results.push(child);
          if (results.length >= limit) return;
        } else if (child instanceof TFolder) {
          collect(child);
          if (results.length >= limit) return;
        }
      }
    };
    collect(folder);
    return results;
  }

  private findFilesByTag(tagValue: string, limit: number): TFile[] {
    const files: TFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const tags = cache?.tags ?? [];
      const normalizedTag = tagValue.startsWith("#") ? tagValue : `#${tagValue}`;
      if (tags.some((tag) => tag.tag === normalizedTag)) {
        files.push(file);
        if (files.length >= limit) break;
      }
    }
    return files;
  }

  /** Run one user turn through the agentic loop */
  async run(
    userMessage: string,
    callbacks: AgentCallbacks,
    selection?: SelectionScope | null,
    externalContexts?: Array<{ path: string; title: string; content?: string }>
  ): Promise<void> {
    this.aborted = false;

    // Build context once per user turn and prepend to the user message
    const context = buildContext(this.app);
    const contextPrefix = buildContextMessage(context);

    // If there's a selection, inject it as scoped context
    let fullMessage: string;
    const mentionContext = await this.buildMentionContext(userMessage);
    const externalContext = await this.buildExternalContext(externalContexts || []);

    if (selection) {
      fullMessage = [
        contextPrefix,
        "",
        mentionContext,
        externalContext,
        `[Selection scope: The user has selected text in ${selection.filePath}. Work only within this selection. When using edit_document, use find_replace with text from within this selection. Do not modify text outside the selection.]`,
        "",
        `Selected text:`,
        `> ${selection.text}`,
        "",
        userMessage,
      ].filter(line => line.length > 0).join("\n");
    } else {
      fullMessage = [contextPrefix, "", mentionContext, externalContext, "", userMessage].filter(line => line.length > 0).join("\n");
    }

    this.messages.push({ role: "user", content: fullMessage });

    // Prune if conversation is too long
    this.pruneHistory();

    // System prompt is static (cache-friendly). Built once, identical every call.
    const systemPrompt = buildSystemPrompt();

    debugLog(this.app, "USER_MESSAGE", { userMessage, hasSelection: !!selection });

    const maxIterations = this.settings.maxIterations || 20;

    for (let i = 0; i < maxIterations; i++) {
      if (this.aborted) return;

      callbacks.onThinking();

      let response;
      try {
        response = await sendMessage(
          this.settings,
          this.messages,
          TOOL_DEFINITIONS,
          systemPrompt
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        debugLog(this.app, "API_ERROR", { error: msg, model: this.settings.model, provider: this.settings.provider });
        callbacks.onError(msg);
        return;
      }

      debugLog(this.app, "API_RESPONSE", { stopReason: response.stopReason, contentTypes: response.content.map(b => b.type), usage: response.usage });

      if (this.aborted) return;

      // Process response content blocks
      const toolCalls: ContentBlock[] = [];
      const textParts: string[] = [];

      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push(block);
        }
      }

      // Emit any text before tool calls (skip if ask_user is coming to avoid
      // rendering the question twice: once as text and once via showAskUser)
      const hasAskUser = toolCalls.some((tc) => tc.name === "ask_user");
      if (textParts.length > 0 && toolCalls.length > 0 && !hasAskUser) {
        callbacks.onResponse(textParts.join(""));
      }

      // Append assistant message to history
      this.messages.push({ role: "assistant", content: response.content });

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        if (textParts.length > 0) {
          callbacks.onResponse(textParts.join(""));
        }
        return;
      }

      // Execute tool calls and collect results
      const resultBlocks: ContentBlock[] = [];

      for (const tc of toolCalls) {
        if (this.aborted) return;

        callbacks.onToolCall(tc.name!, tc.input!);

        const result = await executeTool(
          this.app,
          tc.name!,
          tc.input!,
          callbacks.onAskUser
        );

        callbacks.onToolResult(tc.name!, result);

        resultBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: result.result,
          is_error: result.isError,
        });
      }

      // Append tool results as user message
      this.messages.push({ role: "user", content: resultBlocks });
    }

    // If we get here, we hit the iteration limit
    callbacks.onError(
      `Reached maximum iterations (${maxIterations}). The task may be too complex for a single conversation turn.`
    );
  }

  /** Drop oldest messages when conversation gets too long, keeping recent context */
  private pruneHistory(): void {
    if (this.messages.length > MAX_CONVERSATION_LENGTH) {
      this.messages = this.messages.slice(-KEEP_RECENT);
    }
  }
}


/**
 * Sanitize messages loaded from persistence, stripping any content block
 * types that may not be supported by all providers (e.g. image_url).
 * This prevents serialization errors with providers like DeepSeek that
 * only support "text" type content blocks.
 */
function sanitizeMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  const allowedBlockTypes = new Set(["text", "tool_use", "tool_result"]);
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg;
    // Filter content blocks to only allowed types
    const filtered = msg.content.filter((b) => allowedBlockTypes.has(b.type));
    // If all blocks were filtered out, keep a text placeholder
    if (filtered.length === 0) {
      return { role: msg.role, content: "[Content omitted: unsupported format]" };
    }
    return { ...msg, content: filtered };
  });
}
