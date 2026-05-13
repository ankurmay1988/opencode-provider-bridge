import * as vscode from 'vscode';

let channel: vscode.OutputChannel | null = null;

export function initLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('OpenCode Bridge');
  }
  return channel;
}

export function log(msg: string): void {
  const c = initLogger();
  c.appendLine(`[${timestamp()}] ${msg}`);
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}
