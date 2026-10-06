/**
 * Structured JSON logger for Lambda.
 *
 * Logs are emitted as single-line JSON objects for CloudWatch ingestion.
 * Each entry includes level, message, timestamp, and optional context fields.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  requestId?: string;
  actor?: string;
  action?: string;
  [key: string]: unknown;
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(current: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVEL_ORDER[current] >= LOG_LEVEL_ORDER[threshold];
}

export class Logger {
  private readonly context: Record<string, unknown>;
  private readonly minLevel: LogLevel;

  constructor(context: Record<string, unknown> = {}, minLevel?: LogLevel) {
    this.context = context;
    this.minLevel = minLevel ?? ((process.env.LOG_LEVEL as LogLevel) || 'info');
  }

  /** Create a child logger with additional context fields. */
  child(extra: Record<string, unknown>): Logger {
    return new Logger({ ...this.context, ...extra }, this.minLevel);
  }

  debug(message: string, data?: Record<string, unknown>) {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>) {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>) {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>) {
    this.log('error', message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>) {
    if (!shouldLog(level, this.minLevel)) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...this.context,
      ...data,
    };

    const line = JSON.stringify(entry);

    switch (level) {
      case 'error':
        process.stderr.write(line + '\n');
        break;
      default:
        process.stdout.write(line + '\n');
        break;
    }
  }
}

/** Default application logger instance. */
export const logger = new Logger();
