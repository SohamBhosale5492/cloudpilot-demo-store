import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import {
  trace,
  context,
  propagation,
  Span,
  SpanStatusCode,
  ROOT_CONTEXT,
} from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

export interface TelemetryConfig {
  enabled: boolean;
  serviceName: string;
  otlpEndpoint: string;
}

export function loadTelemetryConfig(serviceName: string): TelemetryConfig {
  const configPath =
    process.env.TRACING_CONFIG_PATH ||
    path.resolve(process.cwd(), '../config/observability/tracing.yaml');

  let enabled = true;
  let otlpEndpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.parse(raw);
      if (parsed?.tracing?.enabled === false) {
        enabled = false;
      }
      if (parsed?.services && parsed.services[serviceName]) {
        if (parsed.services[serviceName].enabled === false) {
          enabled = false;
        }
      }
      if (parsed?.tracing?.otlp_endpoint) {
        otlpEndpoint = parsed.tracing.otlp_endpoint;
      }
    }
  } catch (err) {
    // Fall back to default enabled
  }

  return { enabled, serviceName, otlpEndpoint };
}

let initialized = false;
let isTelemetryEnabled = false;

export function initTelemetry(serviceName: string): { enabled: boolean } {
  if (initialized) return { enabled: isTelemetryEnabled };
  initialized = true;

  const cfg = loadTelemetryConfig(serviceName);
  isTelemetryEnabled = cfg.enabled;

  if (!cfg.enabled) {
    return { enabled: false };
  }

  try {
    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    });

    const tracesUrl = cfg.otlpEndpoint.endsWith('/v1/traces')
      ? cfg.otlpEndpoint
      : `${cfg.otlpEndpoint.replace(/\/$/, '')}/v1/traces`;

    const exporter = new OTLPTraceExporter({ url: tracesUrl });
    const provider = new BasicTracerProvider({ resource });
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
  } catch (err) {
    // If telemetry init fails, continue without breaking service
  }

  return { enabled: true };
}

export function getTracer(serviceName: string) {
  return trace.getTracer(serviceName);
}

export function getCurrentTraceContext(): { traceId?: string; spanId?: string } {
  if (!isTelemetryEnabled) return {};
  const activeSpan = trace.getActiveSpan();
  if (!activeSpan) return {};
  const spanCtx = activeSpan.spanContext();
  return {
    traceId: spanCtx.traceId,
    spanId: spanCtx.spanId,
  };
}

export function startSpanFromRequest(
  serviceName: string,
  spanName: string,
  headers: Record<string, string | string[] | undefined>
): { span?: Span; end: (statusCode?: SpanStatusCode, statusMsg?: string) => void } {
  if (!isTelemetryEnabled) {
    return { end: () => {} };
  }

  try {
    const stringHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string') stringHeaders[k.toLowerCase()] = v;
      else if (Array.isArray(v) && v[0]) stringHeaders[k.toLowerCase()] = v[0];
    }

    const extractedContext = propagation.extract(ROOT_CONTEXT, stringHeaders);
    const tracer = getTracer(serviceName);
    const span = tracer.startSpan(spanName, undefined, extractedContext);
    const ctx = trace.setSpan(extractedContext, span);

    return {
      span,
      end: (code = SpanStatusCode.OK, msg) => {
        if (code !== SpanStatusCode.OK) {
          span.setStatus({ code, message: msg });
        }
        span.end();
      },
    };
  } catch (err) {
    return { end: () => {} };
  }
}

export function injectTraceContext(
  targetHeaders: Record<string, string>
): Record<string, string> {
  if (!isTelemetryEnabled) return targetHeaders;
  try {
    propagation.inject(context.active(), targetHeaders);
  } catch {
    // Ignore injection failure
  }
  return targetHeaders;
}
