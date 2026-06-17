import { App, Modal } from "obsidian";

export class SessionNameModal extends Modal {
  private resolve: (value: string | null) => void;
  private initial: string;

  constructor(app: App, initial = "") {
    super(app);
    this.resolve = () => {};
    this.initial = initial;
  }

  openPrompt(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Session name" });
    const input = contentEl.createEl("input", { type: "text" }) as HTMLInputElement;
    input.value = this.initial;
    input.style.width = "100%";
    input.focus();

    const footer = contentEl.createDiv({ cls: "modal-footer" });
    const ok = footer.createEl("button", { text: "Save" });
    const cancel = footer.createEl("button", { text: "Cancel" });

    ok.onclick = () => {
      const v = input.value.trim();
      this.close();
      this.resolve(v || null);
    };
    cancel.onclick = () => {
      this.close();
      this.resolve(null);
    };

    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        ok.click();
      }
      if (e.key === "Escape") {
        cancel.click();
      }
    };
  }

  onClose(): void {
    // resolved by buttons
  }
}
