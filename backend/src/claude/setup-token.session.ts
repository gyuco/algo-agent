/* eslint-disable no-control-regex -- the CLI output is parsed for terminal escape sequences */
import { spawn, type IPty } from 'node-pty';

const AUTHORIZE_URL =
  /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s\x07\x1b]+/;
// The lookahead waits for the whole token when output arrives in chunks.
const OAUTH_TOKEN = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-])/;
const PASTE_SETTLE_MS = 300;
const OAUTH_ERROR = /OAuth error:\s*(.+?)\s*Press Enter/;
// CSI/OSC escape sequences and other control characters written by the CLI's terminal UI.
const ANSI =
  /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>78]|[\x00-\x08\x0b-\x1f]/g;

/**
 * Drives `claude setup-token` in a pseudo-terminal: the CLI renders an
 * interactive UI and prints nothing without one.
 */
export class SetupTokenSession {
  private readonly term: IPty;
  private output = '';
  private exited = false;
  private readonly listeners = new Set<() => void>();

  constructor(claudeBin: string, env: Record<string, string>) {
    this.term = spawn(claudeBin, ['setup-token'], {
      name: 'xterm-256color',
      // Wide enough that the CLI doesn't wrap the authorize URL.
      cols: 1000,
      rows: 40,
      env,
    });
    this.term.onData((data) => {
      this.output += data;
      this.notify();
    });
    this.term.onExit(() => {
      this.exited = true;
      this.notify();
    });
  }

  /** Resolves with the OAuth authorize URL once the CLI prints it. */
  authorizeUrl(timeoutMs: number): Promise<string> {
    // The URL is printed inside OSC 8 hyperlinks, so match before stripping escapes.
    return this.waitFor(() => this.output.match(AUTHORIZE_URL)?.[0], timeoutMs);
  }

  /** Types the authorization code and resolves with the token the CLI prints. */
  async submitCode(code: string, timeoutMs: number): Promise<string> {
    const offset = this.output.length;
    // A long code arrives as one chunk, which the CLI's input treats as a paste;
    // a carriage return inside that paste is not taken as Enter, so send it apart.
    this.term.write(code);
    await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS));
    this.term.write('\r');
    return this.waitFor(() => {
      const text = this.outputSince(offset);
      const token = text.match(OAUTH_TOKEN)?.[0];
      if (token) return token;
      const error = text.replace(/\s+/g, ' ').match(OAUTH_ERROR)?.[1];
      if (error) return new Error(error);
    }, timeoutMs);
  }

  /** Output printed so far, with escapes stripped and secrets redacted, for diagnostics. */
  redactedOutput(): string {
    return this.outputSince(0)
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-<redacted>')
      .replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n');
  }

  close() {
    if (!this.exited) this.term.kill();
    this.listeners.clear();
  }

  private waitFor(read: () => string | Error | undefined, timeoutMs: number) {
    return new Promise<string>((resolve, reject) => {
      const check = () => {
        const value = read();
        if (value instanceof Error) return done(() => reject(value));
        if (value) return done(() => resolve(value));
        if (this.exited) {
          done(() =>
            reject(new Error(`claude setup-token terminato: ${this.tail()}`)),
          );
        }
      };
      const timer = setTimeout(
        () => done(() => reject(new Error('claude setup-token non risponde'))),
        timeoutMs,
      );
      const done = (settle: () => void) => {
        clearTimeout(timer);
        this.listeners.delete(check);
        settle();
      };
      this.listeners.add(check);
      check();
    });
  }

  private outputSince(offset: number) {
    return this.output.slice(offset).replace(ANSI, ' ');
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private tail() {
    return this.output
      .replace(ANSI, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(-200);
  }
}
