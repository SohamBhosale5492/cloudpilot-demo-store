import { getCurrentTraceContext } from './telemetry';

export type LogLevel = 'info' | 'warn' | 'error';

export class Logger {
  private serviceName: string;
  private lokiPushUrl: string | null;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
    this.lokiPushUrl = process.env.LOKI_PUSH_URL || null;
  }

  log(level: LogLevel, message: string, meta: Record<string, any> = {}) {
    const traceCtx = getCurrentTraceContext();
    const entry: Record<string, any> = {
      timestamp: new Date().toISOString(),
      level,
      service: this.serviceName,
      message,
      ...(traceCtx.traceId ? { trace_id: traceCtx.traceId } : {}),
      ...(traceCtx.spanId ? { span_id: traceCtx.spanId } : {}),
      ...meta,
    };

    const jsonStr = JSON.stringify(entry);
    if (level === 'error') {
      console.error(jsonStr);
    } else if (level === 'warn') {
      console.warn(jsonStr);
    } else {
      console.log(jsonStr);
    }

    if (this.lokiPushUrl) {
      this.pushToLoki(entry, level).catch(() => {});
    }
  }

  info(message: string, meta?: Record<string, any>) {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, any>) {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, any>) {
    this.log('error', message, meta);
  }

  private async pushToLoki(entry: Record<string, any>, level: LogLevel) {
    if (!this.lokiPushUrl) return;
    try {
      const nanoTime = (Date.now() * 1000000).toString();
      const payload = {
        streams: [
          {
            stream: {
              service: this.serviceName,
              level,
            },
            values: [[nanoTime, JSON.stringify(entry)]],
          },
        ],
      };

      await fetch(this.lokiPushUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      // Best-effort
    }
  }
}
