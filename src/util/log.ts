/**
 * Logging with a pluggable sink so the indexer and resolver stay free of any
 * `vscode` import - that is what lets them be exercised headlessly in tests.
 */

export type LogSink = (line: string) => void;

let sink: LogSink | undefined;
let traceEnabled = false;

export function setLogSink(next: LogSink | undefined): void {
  sink = next;
}

export function setTrace(enabled: boolean): void {
  traceEnabled = enabled;
}

export function isTracing(): boolean {
  return traceEnabled;
}

function stamp(): string {
  return new Date().toISOString().substring(11, 23);
}

export function log(message: string): void {
  sink?.(`[${stamp()}] ${message}`);
}

/** Verbose per-resolution logging; off unless `kotlinNavigator.trace` is on. */
export function trace(message: string): void {
  if (traceEnabled) {
    sink?.(`[${stamp()}] [trace] ${message}`);
  }
}

export function logError(message: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  sink?.(`[${stamp()}] [error] ${message}: ${detail}`);
}
