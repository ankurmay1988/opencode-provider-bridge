import * as vscode from 'vscode';

const SETTING = 'opencode-provider-bridge.logLevel';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = keyof typeof LEVELS;

let channel: vscode.OutputChannel | null = null;

export function initLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('OpenCode Bridge');
  }
  return channel;
}

function getThreshold(): number {
  const setting = vscode.workspace.getConfiguration().get<string>(SETTING, 'info');
  return LEVELS[setting as LogLevel] ?? LEVELS.info;
}

export function log(msg: string, level: LogLevel = 'info'): void {
  if (LEVELS[level] > getThreshold()) return;
  const c = initLogger();
  c.appendLine(`[${level.toUpperCase().padEnd(5)} ${timestamp()}] ${msg}`);
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}
