import { App, Modal } from "obsidian";
import type { ChatHistorySession } from "../types";

interface ChatHistoryModalProps {
  sessions: ChatHistorySession[];
  canArchive: boolean;
  onArchive: () => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}

export class ChatHistoryModal extends Modal {
  private props: ChatHistoryModalProps;

  constructor(app: App, props: ChatHistoryModalProps) {
    super(app);
    this.props = props;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("ochat-history-modal");

    this.contentEl.createEl("h2", { text: "Chat history" });

    const headerRow = this.contentEl.createDiv({ cls: "ochat-history-header" });
    if (this.props.canArchive) {
      const archiveButton = headerRow.createEl("button", { text: "Archive current session" });
      archiveButton.addClass("ochat-history-action");
      archiveButton.onclick = () => {
        this.props.onArchive();
        this.close();
        new ChatHistoryModal(this.app, this.props).open();
      };
    }

    if (this.props.sessions.length === 0) {
      this.contentEl.createEl("p", { text: "暂无已保存的聊天会话。" });
      return;
    }

    const list = this.contentEl.createDiv({ cls: "ochat-history-list" });
    // Show newest sessions first
    const sorted = [...this.props.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const session of sorted) {
      const item = list.createDiv({ cls: "ochat-history-item" });
      item.onclick = () => {
        this.props.onRestore(session.id);
        this.close();
      };
      item.createEl("div", { cls: "ochat-history-title", text: session.title });
      item.createEl("div", {
        cls: "ochat-history-meta",
        text: `Updated: ${new Date(session.updatedAt).toLocaleString()}`,
      });

      // Preview: first non-empty text block from chatHistory
      const previewText = (() => {
        for (const h of session.chatHistory) {
          if (h.text && h.text.trim().length > 0) return h.text.trim();
          if (h.toolResult && h.toolResult.result && h.toolResult.result.trim().length > 0) return h.toolResult.result.trim();
        }
        return "(no preview)";
      })();

      item.createEl("div", { cls: "ochat-history-preview", text: previewText.length > 200 ? previewText.slice(0, 197) + "..." : previewText });

      const actions = item.createDiv({ cls: "ochat-history-actions" });
      const restoreButton = actions.createEl("button", { text: "Restore" });
      restoreButton.addClass("ochat-history-action");
      restoreButton.onclick = () => {
        this.props.onRestore(session.id);
        this.close();
      };

      const deleteButton = actions.createEl("button", { text: "Delete" });
      deleteButton.addClass("ochat-history-action");
      deleteButton.onclick = () => {
        this.props.onDelete(session.id);
        item.remove();
      };
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
