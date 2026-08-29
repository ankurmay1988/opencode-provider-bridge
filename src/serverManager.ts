// =============================================================================
// serverManager.ts  —  OpenCode server lifecycle management
// =============================================================================
//
// Owns everything related to finding or starting the opencode server:
//
//   - Health-check-first discovery (cached port → default 4096)
//   - Launching `opencode serve --port <pseudo-random>` in a hidden terminal
//   - CLI availability check + user-facing startup error popup (once/session)
//   - Terminal / port lifecycle (reset on refresh, dispose on deactivate)
//
// Health check is the priority gate. We first reuse an already-running
// server (cached port, then the default 4096 port that `opencode app` /
// `opencode TUI` use). Only if no healthy server exists do we start our own
// `opencode serve --port <pseudo-random>` — opencode allows overriding the
// port via `--port`. If the CLI is missing or the server cannot start, we
// surface a retryable error popup and return null. The opencode server is
// MANDATORY: there is no models.dev / auth.json fallback, so discovery
// returns nothing until the server is available.
// =============================================================================

import * as vscode from 'vscode';

import { log } from './logger.js';
import { spawnSync } from 'node:child_process';

const DEFAULT_PORT = 4096;
const TERMINAL_NAME = 'opencode-bridge';

let serverPort: number | null = null;
let serverTerminal: vscode.Terminal | null = null;
let startupErrorShown = false;

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Finds a healthy opencode server, or starts one if none is running.
 * Returns the port of a server whose /global/health endpoint responds,
 * or null when no server could be found or started.
 *
 * @param onRetry — optional callback invoked when the user clicks "Retry"
 *   on the startup error popup. Lets the caller re-run full discovery once
 *   the user has installed/set up opencode.
 */
export async function ensureOpencodeServer(onRetry?: () => void): Promise<number | null> {
  // 1) Reuse a previously connected server if still healthy.
  if (serverPort) {
    if (await isServerAlive(serverPort)) {return serverPort;}
    log(`Cached port ${serverPort} is dead, reconnecting…`, 'info');
    serverPort = null;
  }

  // 2) Prefer an already-running server on the default port.
  if (await isServerAlive(DEFAULT_PORT)) {
    log(`Server found on default port ${DEFAULT_PORT}`, 'info');
    serverPort = DEFAULT_PORT;
    startupErrorShown = false;
    return DEFAULT_PORT;
  }

  // 3) No server up — the user did not start the opencode app. Verify the
  //    CLI is installed before launching our own headless server.
  if (!isOpencodeCliAvailable()) {
    log(`opencode CLI not found on PATH`, 'warn');
    notifyStartupError(
      `The "opencode" CLI was not found on PATH, so the OpenCode server could not be started.`,
      'The OpenCode Bridge requires the opencode server to discover models. Install opencode, then press Retry.',
      onRetry,
    );
    return null;
  }

  // 4) Launch `opencode serve --port <pseudo-random>` in a hidden terminal.
  log(`Starting headless server…`, 'info');
  const port = await launchTerminal();
  if (!port) {return null;}

  log(`Waiting for server on port ${port}…`, 'info');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(300);
    if (await isServerAlive(port)) {
      log(`Server ready on port ${port}`, 'info');
      serverPort = port;
      startupErrorShown = false;
      return port;
    }
  }

  // 5) The server did not become healthy in time — likely the CLI is missing
  //    or `opencode serve` failed. Tell the user; the server is mandatory.
  log(`Server did not start within timeout.`, 'warn');
  notifyStartupError(
    `The OpenCode server did not start within 15s (is "opencode" installed and able to run "opencode serve"?).`,
    'The OpenCode Bridge requires the opencode server to discover models. Fix the issue, then press Retry.',
    onRetry,
  );
  return null;
}

/**
 * Clears server state so the next discovery re-checks from scratch.
 * Does NOT dispose a running terminal; a subsequent launch replaces it.
 * Used by the Refresh Models command to allow retrying after installs.
 */
export function resetServerState(): void {
  serverPort = null;
  startupErrorShown = false;
}

/**
 * Disposes the managed terminal and clears all server state.
 * Used on extension deactivation.
 */
export function disposeServer(): void {
  if (serverTerminal) {
    serverTerminal.dispose();
    serverTerminal = null;
  }
  serverPort = null;
  startupErrorShown = false;
}

// ---------------------------------------------------------------------------
// INTERNALS
// ---------------------------------------------------------------------------

/** True if the `opencode` CLI resolves on PATH and reports a version. */
function isOpencodeCliAvailable(): boolean {
  try {
    const result = spawnSync('opencode', ['--version'], {
      shell: true,
      stdio: 'ignore',
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Shows a VS Code error notification explaining that the opencode server
 * could not be started, with a "Retry" action (re-runs discovery) and a link
 * to the install docs. Only fires once per session; reset via the refresh
 * command, a successful connection, or pressing Retry.
 */
function notifyStartupError(message: string, detail: string, onRetry?: () => void): void {
  if (startupErrorShown) {return;}
  startupErrorShown = true;
  const actions = onRetry ? ['Retry', 'Get OpenCode'] : ['Get OpenCode'];
  vscode.window.showErrorMessage(`${message} ${detail}`, ...actions)
    .then((choice) => {
      if (choice === 'Get OpenCode') {
        vscode.env.openExternal(vscode.Uri.parse('https://opencode.ai/docs/'));
      } else if (choice === 'Retry') {
        // Allow the popup to appear again if the retry also fails, then
        // re-run discovery so the extension can continue loading normally.
        startupErrorShown = false;
        onRetry?.();
      }
    });
}

async function isServerAlive(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://localhost:${port}/global/health`, { signal: AbortSignal.timeout(1000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function launchTerminal(): Promise<number | null> {
  if (serverTerminal) {
    serverTerminal.dispose();
    serverTerminal = null;
  }

  const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384;
  serverTerminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    iconPath: new vscode.ThemeIcon('hubot'),
    hideFromUser: true,
  });
  serverTerminal.sendText(`opencode serve --port ${port}`);
  return port;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}