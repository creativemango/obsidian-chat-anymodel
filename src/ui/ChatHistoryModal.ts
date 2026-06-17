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
  private currentPage = 1;
  private itemsPerPage = 5;
  private sortedSessions: ChatHistorySession[] = [];
  private listContainer: HTMLElement | null = null;
  private paginationContainer: HTMLElement | null = null;

  constructor(app: App, props: ChatHistoryModalProps) {
    super(app);
    this.props = props;
  }

  get totalPages(): number {
    return Math.ceil(this.sortedSessions.length / this.itemsPerPage);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("ochat-history-modal");

    // Pre-sort sessions
    this.sortedSessions = [...this.props.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.currentPage = 1;

    const headerContainer = this.contentEl.createDiv({ cls: "ochat-history-header-container" });
    headerContainer.createEl("h2", { cls: "ochat-history-title-main", text: "Chat history" });

    const headerRow = this.contentEl.createDiv({ cls: "ochat-history-header" });
    if (this.props.canArchive) {
      const archiveButton = headerRow.createEl("button", { cls: "ochat-history-archive-btn" });
      archiveButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg> Archive current session`;
      archiveButton.onclick = (e) => {
        e.stopPropagation();
        this.props.onArchive();
        this.close();
        new ChatHistoryModal(this.app, this.props).open();
      };
    }

    if (this.props.sessions.length === 0) {
      this.contentEl.createEl("p", { cls: "ochat-history-empty", text: "暂无已保存的聊天会话。" });
      return;
    }

    this.listContainer = this.contentEl.createDiv({ cls: "ochat-history-list" });

    // Pagination container
    this.paginationContainer = this.contentEl.createDiv({ cls: "ochat-history-pagination" });

    this.renderCurrentPage();
  }

  private renderCurrentPage(): void {
    if (!this.listContainer || !this.paginationContainer) return;

    this.listContainer.empty();
    this.paginationContainer.empty();

    const startIndex = (this.currentPage - 1) * this.itemsPerPage;
    const endIndex = startIndex + this.itemsPerPage;
    const currentSessions = this.sortedSessions.slice(startIndex, endIndex);

    for (const session of currentSessions) {
      const item = this.listContainer.createDiv({ cls: "ochat-history-item" });
      item.onclick = (e) => {
        if (!(e.target as HTMLElement).closest('.ochat-history-btn')) {
          this.props.onRestore(session.id);
          this.close();
        }
      };
      
      const content = item.createDiv({ cls: "ochat-history-item-content" });
      
      const titleRow = content.createDiv({ cls: "ochat-history-title-row" });
      titleRow.createEl("div", { cls: "ochat-history-icon" });
      titleRow.createEl("div", { cls: "ochat-history-title", text: session.title });
      
      content.createEl("div", {
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

      content.createEl("div", { cls: "ochat-history-preview", text: previewText.length > 200 ? previewText.slice(0, 197) + "..." : previewText });

      const actions = item.createDiv({ cls: "ochat-history-actions" });
      const restoreButton = actions.createEl("button", { cls: "ochat-history-btn ochat-history-restore-btn" });
      restoreButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path></svg> Restore`;
      restoreButton.onclick = (e) => {
        e.stopPropagation();
        this.props.onRestore(session.id);
        this.close();
      };

      const deleteButton = actions.createEl("button", { cls: "ochat-history-btn ochat-history-delete-btn" });
      deleteButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Delete`;
      deleteButton.onclick = (e) => {
        e.stopPropagation();
        this.props.onDelete(session.id);
        
        // Remove from local array and re-render
        this.sortedSessions = this.sortedSessions.filter(s => s.id !== session.id);
        
        // If current page is now empty and we're not on first page, go back one
        if (this.currentPage > 1 && this.sortedSessions.length <= (this.currentPage - 1) * this.itemsPerPage) {
          this.currentPage--;
        }
        
        this.renderCurrentPage();
      };
    }

    // Render pagination controls
    if (this.totalPages > 1) {
      const paginationInfo = this.paginationContainer.createDiv({ cls: "ochat-history-pagination-info" });
      paginationInfo.setText(`Page ${this.currentPage} of ${this.totalPages} (${this.sortedSessions.length} sessions)`);

      const buttonsContainer = this.paginationContainer.createDiv({ cls: "ochat-history-pagination-buttons" });

      // Previous button
      const prevButton = buttonsContainer.createEl("button", { 
        cls: "ochat-history-pagination-btn",
        attr: { disabled: this.currentPage === 1 ? "true" : null }
      });
      prevButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg> Previous`;
      prevButton.onclick = () => {
        if (this.currentPage > 1) {
          this.currentPage--;
          this.renderCurrentPage();
        }
      };

      // Page number buttons
      for (let i = 1; i <= this.totalPages; i++) {
        const pageBtn = buttonsContainer.createEl("button", { 
          cls: `ochat-history-pagination-btn ochat-history-pagination-number ${i === this.currentPage ? 'active' : ''}`
        });
        pageBtn.setText(String(i));
        pageBtn.onclick = () => {
          this.currentPage = i;
          this.renderCurrentPage();
        };
      }

      // Next button
      const nextButton = buttonsContainer.createEl("button", { 
        cls: "ochat-history-pagination-btn",
        attr: { disabled: this.currentPage === this.totalPages ? "true" : null }
      });
      nextButton.innerHTML = `Next <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
      nextButton.onclick = () => {
        if (this.currentPage < this.totalPages) {
          this.currentPage++;
          this.renderCurrentPage();
        }
      };
    }
  }

  onClose(): void {
    this.contentEl.empty();
    this.listContainer = null;
    this.paginationContainer = null;
  }
}
