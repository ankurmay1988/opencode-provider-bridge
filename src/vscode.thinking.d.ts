/* eslint-disable @typescript-eslint/no-unused-vars */

/**
 * VS Code 1.119+ runtime type for LanguageModelThinkingPart.
 * Not yet published in @types/vscode. Add declare module augmentation.
 *
 * Reference:
 *   - extChatEndpoint.ts: chunk instanceof vscode.LanguageModelThinkingPart
 *   - convertToApiChatMessage: new vscode.LanguageModelThinkingPart(text, id, metadata)
 *   - Issue: https://github.com/microsoft/vscode/issues/262994
 */
declare module 'vscode' {
  export class LanguageModelThinkingPart {
    constructor(value: string, id: string | undefined, metadata: Record<string, unknown>);
    readonly value: string;
    readonly id: string | undefined;
    readonly metadata: Record<string, unknown>;
  }

  export type LanguageModelResponsePart2 = LanguageModelResponsePart | LanguageModelThinkingPart;
}
