import { App, Modal, SearchComponent, Setting } from "obsidian";
import type { TFile } from "obsidian";

/**
 * Modal for selecting external context files
 */
export class SelectContextModal extends Modal {
  private files: TFile[] = [];
  private filteredFiles: TFile[] = [];
  private searchComponent: SearchComponent | undefined;
  private onSelect: (file: TFile) => void;

  constructor(app: App, onSelect: (file: TFile) => void) {
    super(app);
    this.onSelect = onSelect;
    this.files = app.vault.getMarkdownFiles();
    this.filteredFiles = this.files;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Select file for external context" });

    // Search input
    new Setting(contentEl).setName("Search").addSearch((search) => {
      this.searchComponent = search;
      search.setPlaceholder("Type file name...");
      search.onChange((value) => {
        this.filterFiles(value);
      });
      search.inputEl.focus();
    });

    // Files list
    const listEl = contentEl.createDiv("context-file-list");
    listEl.style.maxHeight = "400px";
    listEl.style.overflowY = "auto";
    listEl.style.marginTop = "12px";

    const updateList = () => {
      listEl.empty();
      if (this.filteredFiles.length === 0) {
        listEl.createEl("div", {
          text: "No files found",
          cls: "context-file-none",
        });
        return;
      }

      for (const file of this.filteredFiles.slice(0, 50)) {
        const itemEl = listEl.createEl("div", {
          cls: "context-file-item",
        });
        itemEl.style.padding = "8px 12px";
        itemEl.style.borderBottom = "1px solid var(--background-modifier-border)";
        itemEl.style.cursor = "pointer";
        itemEl.style.transition = "background 0.15s ease";

        const nameEl = itemEl.createEl("div", {
          text: file.basename,
          cls: "context-file-name",
        });
        nameEl.style.fontWeight = "500";

        const pathEl = itemEl.createEl("div", {
          text: file.path,
          cls: "context-file-path",
        });
        pathEl.style.fontSize = "var(--font-ui-smaller)";
        pathEl.style.color = "var(--text-muted)";

        itemEl.onmouseenter = () => {
          itemEl.style.background = "var(--background-modifier-hover)";
        };
        itemEl.onmouseleave = () => {
          itemEl.style.background = "transparent";
        };

        itemEl.onclick = () => {
          this.onSelect(file);
          this.close();
        };
      }
    };

    updateList();

    // Store reference to update list when filtering
    const originalFilterFiles = this.filterFiles.bind(this);
    this.filterFiles = (value: string) => {
      originalFilterFiles(value);
      updateList();
    };
  }

  private filterFiles(query: string): void {
    const lowerQuery = query.toLowerCase();
    this.filteredFiles = this.files.filter(
      (file) =>
        file.basename.toLowerCase().includes(lowerQuery) ||
        file.path.toLowerCase().includes(lowerQuery)
    );
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
