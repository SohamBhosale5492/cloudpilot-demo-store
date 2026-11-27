import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { getCurrentTraceContext } from './telemetry';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LoggingConfig {
  enabled: boolean;
  structuredJson: boolean;
  serviceLabel: string;
  requiredFields: string[];
}

const correlationStorage = new AsyncLocalStorage<string>();

export function runWithCorrelationId<T>(correlationId: string | undefined, fn: () => T): T {
  const value =
    typeof correlationId === 'string' && correlationId.trim().length > 0
      ? correlationId.trim()
      : `corr-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  return correlationStorage.run(value, fn);
}

export function getCurrentCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}

export function injectCorrelationHeader(
  targetHeaders: Record<string, string>
): Record<string, string> {
  const correlationId = getCurrentCorrelationId();
  if (correlationId) {
    targetHeaders['x-correlation-id'] = correlationId;
  }
  return targetHeaders;
}

export function loadLoggingConfig(serviceName: string): LoggingConfig {
  const configPath =
    process.env.LOGGING_CONFIG_PATH ||
    path.resolve(process.cwd(), '../config/observability/logging.yaml');

  let enabled = true;
  let structuredJson = true;
  let serviceLabel = 'service';
  let requiredFields = ['timestamp', 'level', 'service', 'message'];

  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.parse(raw);
      if (typeof parsed?.logging?.service_label === 'string' && parsed.logging.service_label.trim()) {
        serviceLabel = parsed.logging.service_label.trim();
      }
      if (typeof parsed?.logging?.format === 'string' && parsed.logging.format !== 'json') {
        structuredJson = false;
      }
      if (Array.isArray(parsed?.logging?.required_fields)) {
        requiredFields = parsed.logging.required_fields.filter(
          (item: unknown): item is string => typeof item === 'string' && item.trim().length > 0
        );
      }
      const svc = parsed?.services?.[serviceName];
      if (svc && typeof svc === 'object') {
        if (svc.enabled === false) {
          enabled = false;
        }
        if (svc.structured_json === false) {
          structuredJson = false;
        }
        if (Array.isArray(svc.required_fields)) {
          requiredFields = svc.required_fields.filter(
            (item: unknown): item is string => typeof item === 'string' && item.trim().length > 0
          );
        }
      }
    }
  } catch {
    // Fall back to defaults
  }

  return { enabled, structuredJson, serviceLabel, requiredFields };
}

export class Logger {
  private serviceName: string;
  private lokiPushUrl: string | null;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
    this.lokiPushUrl = process.env.LOKI_PUSH_URL || null;
  }

  buildEntry(level: LogLevel, message: string, meta: Record<string, any> = {}): Record<string, any> {
    const cfg = loadLoggingConfig(this.serviceName);
    const traceCtx = getCurrentTraceContext();
    const correlationId = getCurrentCorrelationId();
    const includeCorrelation = cfg.requiredFields.includes('correlation_id');
    const includeEnvironment = cfg.requiredFields.includes('environment');

    return {
      timestamp: new Date().toISOString(),
      level,
      service: this.serviceName,
      message,
      ...(includeCorrelation ? { correlation_id: correlationId || 'corr-system' } : {}),
      ...(includeEnvironment ? { environment: process.env.NODE_ENV || 'production' } : {}),
      ...(traceCtx.traceId ? { trace_id: traceCtx.traceId } : {}),
      ...(traceCtx.spanId ? { span_id: traceCtx.spanId } : {}),
      ...meta,
    };
  }

  log(level: LogLevel, message: string, meta: Record<string, any> = {}) {
    const cfg = loadLoggingConfig(this.serviceName);
    const entry = this.buildEntry(level, message, meta);
    const serialized = cfg.structuredJson
      ? JSON.stringify(entry)
      : `${entry.timestamp} [${level.toUpperCase()}] ${this.serviceName}: ${message}`;

    if (level === 'error') {
      console.error(serialized);
    } else if (level === 'warn') {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }

    const pushUrl = this.lokiPushUrl || process.env.LOKI_PUSH_URL || null;
    if (cfg.enabled && pushUrl) {
      this.pushToLoki(pushUrl, cfg.serviceLabel, serialized, level).catch(() => {});
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

  private async pushToLoki(pushUrl: string, serviceLabel: string, line: string, level: LogLevel) {
    try {
      const nanoTime = (Date.now() * 1000000).toString();
      const payload = {
        streams: [
          {
            stream: {
              [serviceLabel]: this.serviceName,
              level,
            },
            values: [[nanoTime, line]],
          },
        ],
      };

      await fetch(pushUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      // Best-effort
    }
  }
}
