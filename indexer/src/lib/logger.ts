type LogLevel = "debug" | "info" | "warn" | "error";

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function parseLogLevel(input: string | undefined): LogLevel {
  const normalized = (input ?? "info").trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  return "info";
}

function sanitize(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = sanitize(nested);
    }
    return output;
  }
  return value;
}

function toText(level: LogLevel, scope: string, message: string, metadata?: Record<string, unknown>): string {
  const base = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(metadata ? { metadata: sanitize(metadata) } : {})
  };
  return JSON.stringify(base);
}

export class Logger {
  private readonly minLevel: LogLevel;

  constructor(private readonly scope: string, configuredLevel: string | undefined) {
    this.minLevel = parseLogLevel(configuredLevel);
  }

  private shouldLog(level: LogLevel): boolean {
    return levelWeight[level] >= levelWeight[this.minLevel];
  }

  private emit(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }
    const line = toText(level, this.scope, message, metadata);
    if (level === "error") {
      // eslint-disable-next-line no-console
      console.error(line);
      return;
    }
    if (level === "warn") {
      // eslint-disable-next-line no-console
      console.warn(line);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(line);
  }

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.emit("debug", message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.emit("info", message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.emit("warn", message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.emit("error", message, metadata);
  }
}
