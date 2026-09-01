import * as vscode from 'vscode';

const SETTING = 'opencode-provider-bridge.logLevel';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = keyof typeof LEVELS;

let channel: vscode.OutputChannel | null = null;

/**
 * Set to true when the extension activates in the Extension Development Host
 * (`context.extensionMode === Development`). In that mode the log threshold is
 * forced to debug regardless of the user setting, so diagnostics are always
 * visible during F5 debug sessions.
 */
let devMode = false;

export function setDevMode(enabled: boolean): void {
  devMode = enabled;
}

export function isExtensionDevHost(): boolean {
  return devMode;
}

export function initLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('OpenCode Bridge');
  }
  return channel;
}

function getThreshold(): number {
  const setting = vscode.workspace.getConfiguration().get<string>(SETTING, 'info');
  const configured = LEVELS[setting as LogLevel] ?? LEVELS.info;
  // In the Extension Development Host, always log at debug level regardless
  // of the setting so diagnostics are visible during debugging sessions.
  return devMode ? LEVELS.debug : configured;
}

export function log(msg: string, level: LogLevel = 'info'): void {
  if (LEVELS[level] > getThreshold()) {return;}
  const c = initLogger();
  c.appendLine(`[${level.toUpperCase().padEnd(5)} ${timestamp()}] ${msg}`);
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}
