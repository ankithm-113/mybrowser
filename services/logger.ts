/**
 * Tagged console logger with an in-memory ring buffer.
 *
 * Console output goes to the Metro terminal (and `npx expo start` logs). The
 * ring buffer exists so the app can show recent failures on-device, where a
 * developer console is not available.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  tag: string;
  message: string;
}

const MAX_ENTRIES = 300;
const buffer: LogEntry[] = [];

function push(level: LogLevel, tag: string, parts: unknown[]): void {
  const message = parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p instanceof Error) return `${p.name}: ${p.message}`;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(' ');

  buffer.push({ at: Date.now(), level, tag, message });
  if (buffer.length > MAX_ENTRIES) buffer.shift();

  const line = `[${tag}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createLogger(tag: string) {
  return {
    debug: (...parts: unknown[]) => push('debug', tag, parts),
    info: (...parts: unknown[]) => push('info', tag, parts),
    warn: (...parts: unknown[]) => push('warn', tag, parts),
    error: (...parts: unknown[]) => push('error', tag, parts),
  };
}

export function getLogs(level?: LogLevel): LogEntry[] {
  return level ? buffer.filter((e) => e.level === level) : [...buffer];
}

export function clearLogs(): void {
  buffer.length = 0;
}

/** Never print a full API key; this is enough to tell "wrong" from "missing". */
export function describeKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return 'MISSING';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-3)} (len ${trimmed.length})`;
}
