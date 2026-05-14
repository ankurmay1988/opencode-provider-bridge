/**
 * VS Code 1.119+ runtime type for LanguageModelThinkingPart.
 * Not yet published in @types/vscode. Add declare module augmentation.
 *
 * In VS Code 1.120+, LanguageModelResponsePart already includes
 * LanguageModelThinkingPart via the stable API. This augmentation
 * is kept only for compatibility with 1.119.
 *
 * Reference:
 *   - Issue: https://github.com/microsoft/vscode/issues/262994
 */
declare module 'vscode' {
  export class LanguageModelThinkingPart {
    constructor(value: string | string[], id?: string, metadata?: Record<string, unknown>);
    readonly value: string | string[];
    readonly id?: string;
    readonly metadata?: Record<string, unknown>;
  }

  export type LanguageModelResponsePart2 = LanguageModelResponsePart | LanguageModelThinkingPart;
}
