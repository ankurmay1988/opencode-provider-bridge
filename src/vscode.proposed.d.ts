// =============================================================================
// vscode.proposed.d.ts  —  Augmentations for proposed VS Code APIs
// =============================================================================
//
// `isUserSelectable` on LanguageModelChatInformation is available in
// the VS Code 1.120 runtime but not yet published in @types/vscode.
// =============================================================================

export {};

declare module 'vscode' {
  interface LanguageModelChatInformation {
    /**
     * When `true`, the model appears in the chat model picker.
     * When `false` or omitted, the model is hidden from the picker
     * but still visible in the full Language Models dialog.
     */
    readonly isUserSelectable?: boolean;
  }
}
