// ---------------------------------------------------------------------------
// Backend Logger — Persistent Log Stream
// ---------------------------------------------------------------------------
// Intercepts console.log/warn/error from the ui-server process and writes
// all output to a rolling log file at .orchestrace/logs/backend.log.
// Also exposes a method to append runner process stdout/stderr lines.
// ---------------------------------------------------------------------------

import { createWriteStream, existsSync, statSync, renameSync, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

export interface BackendLoggerOptions {
  /** Root .orchestrace directory path. */
  orchestraceDir: string;
  /** Maximum log file size in bytes before rotation (default 5MB). */
  maxFileSize?: number;
  /** Number of rotated log files to keep (default 3). */
  maxFiles?: number;
}

export class BackendLogger {
  private readonly logDir: string;
  private readonly logPath: string;
  private readonly maxFileSize: number;
  private readonly maxFiles: number;
  private stream: WriteStream | null = null;
  private bytesWritten = 0;
  private readonly originalConsole: {
    log: typeof console.log;
    warn: typeof console.warn;
    error: typeof console.error;
    info: typeof console.info;
    debug: typeof console.debug;
  };
  private readonly listeners: Array<(line: string) => void> = [];

  constructor(options: BackendLoggerOptions) {
    this.logDir = join(options.orchestraceDir, 'logs');
    this.logPath = join(this.logDir, 'backend.log');
    this.maxFileSize = options.maxFileSize ?? 5 * 1024 * 1024; // 5MB
    this.maxFiles = options.maxFiles ?? 3;
    this.originalConsole = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console),
      debug: console.debug.bind(console),
    };
  }

  /** Start capturing console output and writing to log file. */
  start(): void {
    mkdirSync(this.logDir, { recursive: true });

    // Check existing file size
    if (existsSync(this.logPath)) {
      try {
        this.bytesWritten = statSync(this.logPath).size;
      } catch {
        this.bytesWritten = 0;
      }
    }

    this.stream = createWriteStream(this.logPath, { flags: 'a' });

    // Intercept console methods
    console.log = (...args: unknown[]) => {
      this.originalConsole.log(...args);
      this.writeLine('INFO', args);
    };
    console.warn = (...args: unknown[]) => {
      this.originalConsole.warn(...args);
      this.writeLine('WARN', args);
    };
    console.error = (...args: unknown[]) => {
      this.originalConsole.error(...args);
      this.writeLine('ERROR', args);
    };
    console.info = (...args: unknown[]) => {
      this.originalConsole.info(...args);
      this.writeLine('INFO', args);
    };
    console.debug = (...args: unknown[]) => {
      this.originalConsole.debug(...args);
      this.writeLine('DEBUG', args);
    };

    this.append('INFO', '[backend-logger] Log capture started');
  }

  /** Append a raw line from a runner process (stdout/stderr). */
  appendRunnerLine(sessionId: string, stream: 'stdout' | 'stderr', line: string): void {
    const level = stream === 'stderr' ? 'ERROR' : 'INFO';
    this.append(level, `[runner:${sessionId}] ${line}`);
  }

  /** Register a listener that receives every log line written. */
  onLine(callback: (line: string) => void): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Stop capturing and flush the stream. */
  stop(): void {
    // Restore original console
    console.log = this.originalConsole.log;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    console.info = this.originalConsole.info;
    console.debug = this.originalConsole.debug;

    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }

  /** Get the log file path (for external readers). */
  getLogPath(): string {
    return this.logPath;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private writeLine(level: string, args: unknown[]): void {
    const message = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');
    this.append(level, message);
  }

  private append(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const line = `${timestamp} [${level}] ${message}\n`;

    if (this.stream && !this.stream.destroyed) {
      this.stream.write(line);
      this.bytesWritten += Buffer.byteLength(line, 'utf8');

      // Notify listeners
      for (const listener of this.listeners) {
        try {
          listener(line);
        } catch {
          // Don't let listener errors break logging
        }
      }

      // Rotate if needed
      if (this.bytesWritten >= this.maxFileSize) {
        this.rotate();
      }
    }
  }

  private rotate(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }

    // Shift existing rotated files
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? this.logPath : `${this.logPath}.${i - 1}`;
      const to = `${this.logPath}.${i}`;
      if (existsSync(from)) {
        try {
          renameSync(from, to);
        } catch {
          // Best effort
        }
      }
    }

    // Re-open fresh log file
    this.bytesWritten = 0;
    this.stream = createWriteStream(this.logPath, { flags: 'w' });
    this.append('INFO', '[backend-logger] Log rotated');
  }
}

function safeStringify(value: unknown): string {
  try {
    if (value instanceof Error) {
      return value.stack ?? value.message;
    }
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
