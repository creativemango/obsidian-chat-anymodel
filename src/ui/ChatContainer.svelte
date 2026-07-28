<script lang="ts">
  import type { App, Component as ObsidianComponent } from "obsidian";
  import { MarkdownRenderer } from "obsidian";
  import type { ToolResult, SelectionScope } from "../types";

  interface ChatMessage {
    id: number;
    type: "user" | "assistant" | "tool-call" | "tool-result" | "error" | "thinking";
    text?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: ToolResult;
  }

  interface ExternalContext {
    path: string;
    title: string;
    content: string;
  }

  interface Props {
    app: App;
    component: ObsidianComponent;
    provider: string;
    model: string;
    onSend: (text: string, selection: SelectionScope | null) => void;
    onNew: () => void;
    onClear: () => void;
    onStop: () => void;
    onHistory: () => void;
  }

  let { app, component, provider, model, onSend, onNew, onClear, onStop, onHistory }: Props = $props();

  let displayModel = $state("");
  let messages = $state<ChatMessage[]>([]);
  let inputText = $state("");
  let inputEnabled = $state(true);
  let placeholder = $state("Ask anything...");
  let messagesEl: HTMLElement | undefined = $state();
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let nextId = 0;

  // Selection scope (shown as a pill above input)
  let selection = $state<SelectionScope | null>(null);

  // Hidden mention tokens that should be sent to the agent but not displayed  
  let hiddenMentions = $state<string[]>([]);
  
  // Timer for closing suggestions on blur
  let closeSuggestionsTimer: any = null;

  // @ mention autocomplete for files, folders, tags, and current file
  interface MentionSuggestion {
    kind: "file" | "folder" | "tag" | "current";
    path: string;
    title: string;
    subtitle: string;
    insert: string;
  }

  let noteSuggestions = $state<MentionSuggestion[]>([]);
  let showNoteSuggestions = $state(false);
  let mentionRange: { start: number; end: number } | null = $state(null);
  let highlightedSuggestion = $state(0);

  // External contexts (for desktop only)
  let externalContexts = $state<ExternalContext[]>([]);
  let fileInputEl: HTMLInputElement | undefined = $state();

  // Detect if device is mobile
  function isMobileDevice(): boolean {
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  }

  // ask_user support
  let askUserResolve: ((value: string) => void) | null = $state(null);

  // Sync model prop to local state (also updateable via setModel)
  $effect(() => {
    displayModel = model;
  });

  // Auto-scroll when messages change
  $effect(() => {
    // Track messages array length to trigger scroll
    messages.length;
    if (messagesEl) {
      requestAnimationFrame(() => {
        messagesEl!.scrollTop = messagesEl!.scrollHeight;
      });
    }
  });

  // ─── Public API (called from chat-view.ts / chat-modal.ts) ────────────

  export function addUserMessage(text: string): void {
    messages.push({ id: nextId++, type: "user", text });
  }

  export function addAssistantMessage(text: string): void {
    messages.push({ id: nextId++, type: "assistant", text });
  }

  export function addToolCall(name: string, input: Record<string, unknown>): number {
    const id = nextId++;
    messages.push({ id, type: "tool-call", toolName: name, toolInput: input });
    return id;
  }

  export function updateToolResult(msgId: number, name: string, result: ToolResult): void {
    const msg = messages.find((m) => m.id === msgId);
    if (msg) {
      msg.type = "tool-result";
      msg.toolName = name;
      msg.toolResult = result;
    }
  }

  export function showThinking(): void {
    // Only add if not already showing
    if (!messages.some((m) => m.type === "thinking")) {
      messages.push({ id: nextId++, type: "thinking" });
    }
  }

  export function hideThinking(): void {
    const idx = messages.findIndex((m) => m.type === "thinking");
    if (idx !== -1) messages.splice(idx, 1);
  }

  export function addError(text: string): void {
    messages.push({ id: nextId++, type: "error", text });
  }

  export function showAskUser(question: string): Promise<string> {
    addAssistantMessage(question);
    placeholder = "Type your answer...";
    inputEnabled = true;
    textareaEl?.focus();

    return new Promise<string>((resolve) => {
      askUserResolve = resolve;
    });
  }

  export function setInputEnabled(enabled: boolean): void {
    inputEnabled = enabled;
    placeholder = enabled ? "Ask anything..." : "Waiting for response...";
  }

  export function clearMessages(): void {
    messages = [];
    selection = null;
    hiddenMentions = [];
    hideThinking();
  }

  export function focus(): void {
    textareaEl?.focus();
  }

  /** Update the model display name in the header */
  export function setModel(name: string): void {
    displayModel = name;
  }

  /** Set the selection scope (shows pill in UI) */
  export function setSelection(sel: SelectionScope): void {
    selection = sel;
  }

  /** Get the current selection scope */
  export function getSelection(): SelectionScope | null {
    return selection;
  }

  /** Clear the selection scope */
  export function clearSelection(): void {
    selection = null;
  }

  /** Add external context file */
  export function addExternalContext(path: string, title: string, content: string): void {
    const existing = externalContexts.find((ctx) => ctx.path === path);
    if (!existing) {
      externalContexts.push({ path, title, content });
    }
  }

  /** Remove external context */
  export function removeExternalContext(path: string): void {
    const idx = externalContexts.findIndex((ctx) => ctx.path === path);
    if (idx !== -1) {
      externalContexts.splice(idx, 1);
    }
  }

  /** Get all external contexts */
  export function getExternalContexts(): ExternalContext[] {
    return externalContexts;
  }

  // ─── Internal handlers ────────────────────────────────────────────────

  function handleSend(): void {
    const text = inputText.trim();
    if (!text) return;

    inputText = "";
    resetHeight();

    if (askUserResolve) {
      addUserMessage(text);
      const resolve = askUserResolve;
      askUserResolve = null;
      resolve(text);
      return;
    }

    // Prepend hidden mention tokens (e.g. @current) so agent loop still processes them
    let sendText = text;
    if (hiddenMentions.length > 0) {
      sendText = `${hiddenMentions.join(" ")} ${text}`;
      hiddenMentions = [];
    }

    // Pass current selection and consume it (one-shot per send)
    const currentSelection = selection;
    selection = null;
    onSend(sendText, currentSelection);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (showNoteSuggestions) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        highlightedSuggestion = Math.min(highlightedSuggestion + 1, noteSuggestions.length - 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        highlightedSuggestion = Math.max(highlightedSuggestion - 1, 0);
        return;
      }
      if (e.key === "Enter" && highlightedSuggestion >= 0 && noteSuggestions.length > 0) {
        e.preventDefault();
        selectNoteSuggestion(highlightedSuggestion);
        return;
      }
      if (e.key === "Escape") {
        showNoteSuggestions = false;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function autoGrow(): void {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 300) + "px";
  }

  function resetHeight(): void {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
  }

  function selectNoteSuggestion(index: number): void {
    const suggestion = noteSuggestions[index];
    if (!suggestion || !mentionRange || !textareaEl) return;

    const before = inputText.slice(0, mentionRange.start);
    const after = inputText.slice(mentionRange.end);
    inputText = `${before}${suggestion.insert}${after}`;
    showNoteSuggestions = false;
    mentionRange = null;

    // Store hidden mention tokens so the agent loop still gets @current context
    if (suggestion.kind === "current") {
      if (!hiddenMentions.includes("@current")) {
        hiddenMentions = [...hiddenMentions, "@current"];
      }
    }

    textareaEl.focus();
  }

  function gatherFolders(folder: any, results: { path: string; title: string }[]): void {
    const children = (folder.children || []) as any[];
    for (const child of children) {
      if (child instanceof Object && child.children) {
        results.push({ path: child.path, title: child.name });
        gatherFolders(child, results);
      }
    }
  }

  function updateNoteSuggestions(): void {
    if (closeSuggestionsTimer) {
      clearTimeout(closeSuggestionsTimer);
      closeSuggestionsTimer = null;
    }
    const cursorPos = textareaEl?.selectionStart ?? inputText.length;
    const textBefore = inputText.slice(0, cursorPos);
    // 匹配 @ 后面的内容，但不包含空格
    const match = textBefore.match(/@([\w\-\u4e00-\u9fa5:\/#\.+_]*)$/);
    if (!match) {
      showNoteSuggestions = false;
      mentionRange = null;
      return;
    }

    const rawQuery = match[1].trim();
    const query = rawQuery.toLowerCase();
    const start = cursorPos - match[0].length;
    mentionRange = { start, end: cursorPos };

    const currentFile = app.workspace.getActiveFile();
    const fileItems = app.vault.getMarkdownFiles().map((file) => ({
      kind: "file" as const,
      path: file.path,
      title: file.basename,
      subtitle: file.path,
      insert: `[[${file.basename}]]`,
    }));

    const folders: { path: string; title: string }[] = [];
    gatherFolders(app.vault.getRoot(), folders);
    const folderItems = folders.map((folder) => ({
      kind: "folder" as const,
      path: folder.path,
      title: folder.title,
      subtitle: folder.path,
      insert: `@folder:${folder.path}`,
    }));

    const tagMap = new Map<string, string>();
    for (const file of app.vault.getMarkdownFiles()) {
      const cache = app.metadataCache.getFileCache(file);
      const tags = cache?.tags ?? [];
      for (const tag of tags) {
        tagMap.set(tag.tag, tag.tag);
      }
    }
    const tagItems = Array.from(tagMap.values()).map((tag) => ({
      kind: "tag" as const,
      path: tag,
      title: tag,
      subtitle: "tag",
      insert: `@tag:${tag.replace(/^#/, "")}`,
    }));

    const suggestions: MentionSuggestion[] = [];
    if (currentFile) {
      suggestions.push({
        kind: "current",
        path: currentFile.path,
        title: "Current file",
        subtitle: currentFile.path,
        insert: `[[${currentFile.name}]]`,
      });
    }

    const normalized = query.replace(/^folder:/, "").replace(/^tag:/, "").replace(/^file:/, "").trim();
    const isFolderSearch = query.startsWith("folder:");
    const isTagSearch = query.startsWith("tag:");
    const isFileSearch = query.startsWith("file:");

    const fileMatches = fileItems.filter((item) =>
      (!isFolderSearch && !isTagSearch && !isFileSearch) || isFileSearch
        ? item.title.toLowerCase().includes(normalized) || item.subtitle.toLowerCase().includes(normalized)
        : false
    );

    const folderMatches = folderItems.filter((item) =>
      (!isFolderSearch && !isTagSearch && !isFileSearch) || isFolderSearch
        ? item.title.toLowerCase().includes(normalized) || item.subtitle.toLowerCase().includes(normalized)
        : false
    );

    const tagMatches = tagItems.filter((item) =>
      (!isFolderSearch && !isTagSearch && !isFileSearch) || isTagSearch
        ? item.title.toLowerCase().includes(normalized)
        : false
    );

    if (!isTagSearch && !isFolderSearch && !isFileSearch) {
      suggestions.push(...fileItems.filter(item => normalized.length === 0 || item.title.toLowerCase().includes(normalized) || item.subtitle.toLowerCase().includes(normalized)).slice(0, 15));
      suggestions.push(...folderItems.filter(item => normalized.length === 0 || item.title.toLowerCase().includes(normalized) || item.subtitle.toLowerCase().includes(normalized)).slice(0, 10));
      suggestions.push(...tagItems.filter(item => normalized.length === 0 || item.title.toLowerCase().includes(normalized)).slice(0, 8));
    } else {
      suggestions.push(...fileMatches.slice(0, 15));
      suggestions.push(...folderMatches.slice(0, 10));
      suggestions.push(...tagMatches.slice(0, 8));
    }

    noteSuggestions = suggestions;
    showNoteSuggestions = noteSuggestions.length > 0;
    highlightedSuggestion = 0;
  }

  // Render markdown into a DOM node using Obsidian's renderer
  function renderMarkdown(node: HTMLElement, text: string): void {
    node.empty();
    MarkdownRenderer.render(app, text, node, "", component);
  }

  // Use action for markdown rendering
  function markdown(node: HTMLElement, text: string) {
    renderMarkdown(node, text);
    return {
      update(newText: string) {
        renderMarkdown(node, newText);
      },
    };
  }

  function formatToolName(name: string): string {
    return name.replace(/_/g, " ");
  }

  function truncate(str: string, max: number): string {
    if (str.length <= max) return str;
    return str.substring(0, max) + "\n... (truncated)";
  }

  function handleAddFile(): void {
    fileInputEl?.click();
  }

  function handleFileInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    for (const file of Array.from(input.files)) {
      const reader = new FileReader();
      reader.onload = () => {
        const content = typeof reader.result === "string" ? reader.result : "";
        addExternalContext(file.name, file.name, content);
      };
      reader.readAsText(file);
    }

    input.value = "";
  }
</script>

<div class="ochat-container">
  <!-- Header -->
  <div class="ochat-header">
    <div class="ochat-header-left">
      <div class="ochat-model-selector-header">
        <span class="ochat-header-title">Chat</span>
        <span class="ochat-model-tag">(free)</span>
        <svg class="ochat-dropdown-arrow" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </div>
    </div>
  </div>

  <!-- Messages -->
  <div class="ochat-messages" bind:this={messagesEl}>
    {#each messages as msg (msg.id)}
      {#if msg.type === "user"}
        <div class="ochat-msg ochat-user-msg">
          <div class="ochat-msg-content">{msg.text}</div>
        </div>

      {:else if msg.type === "assistant"}
        <div class="ochat-msg ochat-assistant-msg">
          <div class="ochat-msg-content" use:markdown={msg.text ?? ""}></div>
        </div>

      {:else if msg.type === "tool-call"}
        <div class="ochat-tool-call">
          <div class="ochat-tool-status">
            <span class="ochat-spinner"></span>
            <span class="ochat-tool-name">{formatToolName(msg.toolName ?? "")}</span>
          </div>
          <details class="ochat-tool-details">
            <summary>Parameters</summary>
            <pre class="ochat-tool-json">{JSON.stringify(msg.toolInput, null, 2)}</pre>
          </details>
        </div>

      {:else if msg.type === "tool-result"}
        <div class="ochat-tool-call">
          <div class="ochat-tool-status">
            <span class={msg.toolResult?.isError ? "ochat-tool-error" : "ochat-tool-success"}>
              {msg.toolResult?.isError ? "\u2718" : "\u2714"}
            </span>
            <span class="ochat-tool-name">{formatToolName(msg.toolName ?? "")}</span>
          </div>
          <details class="ochat-tool-details">
            <summary>{msg.toolResult?.isError ? "Error" : "Result"}</summary>
            <pre class="ochat-tool-json">{truncate(msg.toolResult?.result ?? "", 2000)}</pre>
          </details>
        </div>

      {:else if msg.type === "error"}
        <div class="ochat-msg ochat-error-msg">
          <div class="ochat-msg-content">{msg.text}</div>
        </div>

      {:else if msg.type === "thinking"}
        <div class="ochat-thinking">
          <span class="ochat-dot"></span>
          <span class="ochat-dot"></span>
          <span class="ochat-dot"></span>
        </div>
      {/if}
    {/each}
  </div>

  <div class="ochat-input-actions">
    <button 
      class="ochat-icon-btn ochat-new-btn" 
      onclick={onNew} 
      aria-label="New chat"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"></path></svg>
    </button>
    <button 
      class="ochat-icon-btn ochat-history-btn" 
      onclick={onHistory} 
      aria-label="History"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10H12V2z"></path><path d="M12 2L21 6 16 12"></path></svg>
    </button>
  </div>

  <div class="ochat-input-panel">
    <div class="ochat-input-top">
      <button 
        class="ochat-at-btn" 
        onmousedown={(e) => {
          e.preventDefault();
          if (closeSuggestionsTimer) {
            clearTimeout(closeSuggestionsTimer);
            closeSuggestionsTimer = null;
          }
        }}
        onclick={() => {
          if (closeSuggestionsTimer) {
            clearTimeout(closeSuggestionsTimer);
            closeSuggestionsTimer = null;
          }
          textareaEl?.focus();
          
          // Wait a tick to make sure focus is applied
          setTimeout(() => {
            if (!inputText.endsWith("@")) {
              inputText += "@";
              // Wait another tick for the state update
              setTimeout(() => {
                updateNoteSuggestions();
              }, 0);
            } else {
              updateNoteSuggestions();
            }
          }, 0);
        }}
        aria-label="Add context"
      >@</button>

      {#if selection}
        <div class="ochat-context-pill">
          <span class="ochat-context-icon">📄</span>
          <span class="ochat-context-text">{selection.filePath.split("/").pop()}</span>
          <span class="ochat-context-sub">Current</span>
          <button class="ochat-context-close" aria-label="Remove selection" onclick={() => selection = null}>
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      {/if}

      {#each externalContexts as context}
        <div class="ochat-context-pill">
          <span class="ochat-context-icon">🔗</span>
          <span class="ochat-context-text">{context.title}</span>
          <button class="ochat-context-close" aria-label="Remove context" onclick={() => removeExternalContext(context.path)}>
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      {/each}
    </div>

    <div class="ochat-input-bar">
      <textarea
        class="ochat-input"
        bind:this={textareaEl}
        bind:value={inputText}
        placeholder="Your AI assistant for Obsidian • @ to add context • / for custom prompts"
        disabled={!inputEnabled}
        rows="1"
        onkeydown={handleKeydown}
        oninput={() => {
          autoGrow();
          updateNoteSuggestions();
        }}
        onfocus={updateNoteSuggestions}
        onblur={() => {
          closeSuggestionsTimer = setTimeout(() => {
            showNoteSuggestions = false;
          }, 200);
        }}
      ></textarea>
      {#if showNoteSuggestions}
        <div class="ochat-note-suggestions" role="listbox">
          {#each noteSuggestions as suggestion, index}
            <div
              class="ochat-note-suggestion {index === highlightedSuggestion ? 'active' : ''}"
              role="option"
              aria-selected={index === highlightedSuggestion}
              tabindex="-1"
              onmousedown={(event) => {
                event.preventDefault();
                if (closeSuggestionsTimer) {
                  clearTimeout(closeSuggestionsTimer);
                  closeSuggestionsTimer = null;
                }
                selectNoteSuggestion(index);
              }}
            >
              <div class="ochat-note-title">{suggestion.title}</div>
              <div class="ochat-note-path">{suggestion.path}</div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="ochat-input-bottom">
      <div class="ochat-model-selector">
        <span class="ochat-model-name">{displayModel || "No model"}</span>
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </div>

      <div class="ochat-bottom-right">
        {#if !isMobileDevice() && inputEnabled}
          <button
            class="ochat-folder-btn"
            onclick={handleAddFile}
            aria-label="Add external context"
            title="Add external context"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
          </button>
          <input
            type="file"
            bind:this={fileInputEl}
            style="display: none;"
            multiple
            onchange={handleFileInput}
          />
        {/if}
        {#if !inputEnabled}
          <button
            class="ochat-stop-btn"
            onclick={onStop}
            aria-label="Stop responding"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
          </button>
        {/if}
        <button
          class="ochat-send-btn"
          class:active={inputText.trim().length > 0}
          onclick={handleSend}
          aria-label="Send message"
          disabled={!inputEnabled}
        >
          <span class="ochat-send-label">chat</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10L4 15L9 20"></path><path d="M20 4V11C20 13.2091 18.2091 15 16 15H4"></path></svg>
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  /* ─── Container ─────────────────────────────────────────────────────── */
  .ochat-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ─── Header ────────────────────────────────────────────────────────── */
  .ochat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
  }

  .ochat-header-left {
    display: flex;
    align-items: center;
  }

  .ochat-model-selector-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: var(--radius-s);
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .ochat-model-selector-header:hover {
    background: var(--background-modifier-hover);
  }

  .ochat-header-title {
    font-weight: 600;
    font-size: var(--font-ui-medium);
    color: var(--text-normal);
  }

  .ochat-model-tag {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .ochat-dropdown-arrow {
    color: var(--text-muted);
  }

  .ochat-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    border-radius: var(--radius-s);
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ochat-icon-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .ochat-note-suggestions {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 100%;
    max-height: 250px;
    overflow-y: auto;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.2);
    z-index: 1000;
    margin-bottom: 8px;
    padding: 6px 0;
  }

  .ochat-note-suggestion {
    padding: 12px 16px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-bottom: 1px solid var(--background-modifier-border);
    transition: background 0.12s ease;
  }

  .ochat-note-suggestion:last-child {
    border-bottom: none;
  }

  .ochat-note-suggestion:hover,
  .ochat-note-suggestion.active {
    background: var(--background-modifier-hover);
  }

  .ochat-note-title {
    font-size: var(--font-ui-medium);
    font-weight: 500;
    color: var(--text-normal);
  }

  .ochat-note-path {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    word-break: break-all;
  }

  /* ─── Messages ──────────────────────────────────────────────────────── */
  .ochat-messages {
    flex: 9 1 0;
    min-height: 3rem;
    max-height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    -webkit-user-select: text;
    user-select: text;
  }

  .ochat-msg {
    max-width: 90%;
    padding: 8px 12px;
    border-radius: var(--radius-m);
    line-height: 1.5;
    word-wrap: break-word;
    -webkit-user-select: text;
    user-select: text;
  }

  .ochat-user-msg {
    align-self: flex-end;
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-bottom-right-radius: var(--radius-s);
  }

  .ochat-assistant-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-normal);
    border-bottom-left-radius: var(--radius-s);
  }

  .ochat-assistant-msg :global(p:first-child) {
    margin-top: 0;
  }

  .ochat-assistant-msg :global(p:last-child) {
    margin-bottom: 0;
  }

  .ochat-error-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-error);
    border-left: 3px solid var(--text-error);
    font-size: var(--font-ui-smaller);
    max-width: 90%;
  }

  /* ─── Tool Calls ────────────────────────────────────────────────────── */
  .ochat-tool-call {
    align-self: flex-start;
    padding: 6px 10px;
    background: var(--background-secondary-alt);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    max-width: 90%;
  }

  .ochat-tool-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ochat-tool-name {
    font-weight: 500;
  }

  .ochat-tool-success {
    color: var(--text-success);
  }

  .ochat-tool-error {
    color: var(--text-error);
  }

  .ochat-tool-details {
    margin-top: 4px;
  }

  .ochat-tool-details summary {
    cursor: pointer;
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }

  .ochat-tool-json {
    margin: 4px 0 0;
    padding: 6px 8px;
    background: var(--background-primary);
    border-radius: var(--radius-s);
    font-size: 11px;
    max-height: 150px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* ─── Spinner ───────────────────────────────────────────────────────── */
  .ochat-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--text-faint);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: ochat-spin 0.6s linear infinite;
  }

  @keyframes ochat-spin {
    to { transform: rotate(360deg); }
  }

  /* ─── Thinking Dots ─────────────────────────────────────────────────── */
  .ochat-thinking {
    align-self: flex-start;
    display: flex;
    gap: 4px;
    padding: 8px 12px;
  }

  .ochat-dot {
    width: 8px;
    height: 8px;
    background: var(--text-faint);
    border-radius: 50%;
    animation: ochat-pulse 1.4s ease-in-out infinite;
  }

  .ochat-dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .ochat-dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes ochat-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  /* ─── Input Bar ─────────────────────────────────────────────────────── */
  .ochat-input-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 0 12px;
    margin-bottom: 4px;
  }

  .ochat-input-panel {
    display: flex;
    flex-direction: column;
    padding: 12px;
    border: 1px solid var(--background-modifier-border);
    background: var(--background-primary);
    border-radius: var(--radius-l);
    margin: 12px;
    flex-shrink: 0;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
  }

  .ochat-input-top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .ochat-at-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
    padding: 0;
  }

  .ochat-at-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .ochat-context-pill {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
  }

  .ochat-context-icon {
    font-size: 12px;
  }

  .ochat-context-text {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-normal);
  }

  .ochat-context-sub {
    color: var(--text-muted);
    font-size: 10px;
    margin-left: 2px;
  }

  .ochat-context-close {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 0;
    margin-left: 4px;
    color: var(--text-muted);
    cursor: pointer;
  }

  .ochat-context-close:hover {
    color: var(--text-error);
  }

  .ochat-input-bar {
    display: flex;
    flex-direction: column;
    position: relative;
    margin-bottom: 8px;
  }

  .ochat-input {
    width: 100%;
    resize: none;
    border: none;
    padding: 0;
    font-size: var(--font-ui-medium);
    font-family: var(--font-interface);
    background: transparent;
    color: var(--text-normal);
    line-height: 1.5;
    max-height: 200px;
    overflow-y: auto;
  }

  .ochat-input:focus {
    outline: none;
  }

  .ochat-input-bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
  }

  .ochat-model-selector {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: var(--radius-s);
    margin-left: -4px;
  }

  .ochat-model-selector:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .ochat-bottom-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .ochat-folder-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 4px;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-s);
  }

  .ochat-folder-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .ochat-send-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    border-radius: var(--radius-m);
    background-color: var(--background-secondary);
    color: var(--text-muted);
    cursor: pointer;
    font-weight: 500;
    transition: all 0.2s ease;
  }

  .ochat-send-btn:hover:not(:disabled),
  .ochat-send-btn.active {
    background-color: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .ochat-send-label {
    font-size: var(--font-ui-smaller);
  }

  .ochat-send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Stop button (shown when AI is responding) */
  .ochat-stop-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 6px;
    border: none;
    border-radius: var(--radius-m);
    background-color: var(--background-modifier-error);
    color: var(--text-on-accent);
    cursor: pointer;
    transition: background-color 0.2s ease;
    flex-shrink: 0;
  }

  .ochat-stop-btn:hover {
    background-color: var(--background-modifier-error-hover, #c0392b);
  }


  /* ─── Responsive ────────────────────────────────────────────────────── */
  @media (max-width: 768px) {
    .ochat-input-panel {
      margin: 8px;
      padding: 10px;
    }

    .ochat-input {
      font-size: 16px;
    }
  }
</style>
