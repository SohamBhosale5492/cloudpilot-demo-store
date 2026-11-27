import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import {
  trace,
  context,
  propagation,
  Context,
  ContextManager,
  Span,
  SpanStatusCode,
  ROOT_CONTEXT,
} from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

export interface TelemetryConfig {
  enabled: boolean;
  serviceName: string;
  otlpEndpoint: string;
}

export interface InitTelemetryOptions {
  spanProcessor?: SpanProcessor;
  forceReinit?: boolean;
}

const GLOBAL_CONTEXT_MANAGER_KEY = Symbol.for('cloudpilot.demo-store.otel.contextManager');

class AsyncLocalStorageContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(ctx, () => fn.apply(thisArg as ThisParameterType<F>, args));
  }

  bind<T>(ctx: Context, target: T): T {
    if (typeof target === 'function') {
      const manager = this;
      return function (this: unknown, ...args: unknown[]) {
        return manager.with(ctx, () => (target as (...fnArgs: unknown[]) => unknown).apply(this, args));
      } as unknown as T;
    }
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.storage.disable();
    return this;
  }
}

function ensureGlobalContextManager(): ContextManager {
  const g = globalThis as Record<symbol, ContextManager | undefined>;
  if (!g[GLOBAL_CONTEXT_MANAGER_KEY]) {
    const manager = new AsyncLocalStorageContextManager();
    context.setGlobalContextManager(manager);
    g[GLOBAL_CONTEXT_MANAGER_KEY] = manager;
  }
  return g[GLOBAL_CONTEXT_MANAGER_KEY]!;
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
  } catch {
    // Fall back to default enabled
  }

  return { enabled, serviceName, otlpEndpoint };
}

let initialized = false;
let isTelemetryEnabled = false;
let serviceProvider: BasicTracerProvider | null = null;

export function resetTelemetryForTests(): void {
  if (serviceProvider) {
    void serviceProvider.shutdown().catch(() => {});
  }
  initialized = false;
  isTelemetryEnabled = false;
  serviceProvider = null;
}

export function initTelemetry(
  serviceName: string,
  options: InitTelemetryOptions = {}
): { enabled: boolean } {
  if (initialized && !options.forceReinit) return { enabled: isTelemetryEnabled };
  initialized = true;

  const cfg = loadTelemetryConfig(serviceName);
  isTelemetryEnabled = cfg.enabled;

  if (!cfg.enabled) {
    serviceProvider = null;
    return { enabled: false };
  }

  try {
    const contextManager = ensureGlobalContextManager();
    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    });

    const tracesUrl = cfg.otlpEndpoint.endsWith('/v1/traces')
      ? cfg.otlpEndpoint
      : `${cfg.otlpEndpoint.replace(/\/$/, '')}/v1/traces`;

    const processor =
      options.spanProcessor ??
      new SimpleSpanProcessor(new OTLPTraceExporter({ url: tracesUrl }));
    const provider = new BasicTracerProvider({ resource });
    provider.addSpanProcessor(processor);
    provider.register({ contextManager });
    serviceProvider = provider;
  } catch {
    // If telemetry init fails, continue without breaking service
  }

  return { enabled: true };
}

export function getTracer(serviceName: string) {
  return serviceProvider ? serviceProvider.getTracer(serviceName) : trace.getTracer(serviceName);
}

export function getCurrentTraceContext(): { traceId?: string; spanId?: string } {
  if (!isTelemetryEnabled) return {};
  const activeSpan = trace.getActiveSpan();
  if (!activeSpan) return {};
  const spanCtx = activeSpan.spanContext();
  if (!spanCtx || !spanCtx.traceId || /^0+$/.test(spanCtx.traceId)) return {};
  return {
    traceId: spanCtx.traceId,
    spanId: spanCtx.spanId,
  };
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const stringHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') stringHeaders[k.toLowerCase()] = v;
    else if (Array.isArray(v) && v[0]) stringHeaders[k.toLowerCase()] = v[0];
  }
  return stringHeaders;
}

export function startSpanFromRequest(
  serviceName: string,
  spanName: string,
  headers: Record<string, string | string[] | undefined>
): {
  span?: Span;
  context: Context;
  run: <T>(fn: () => T) => T;
  end: (statusCode?: SpanStatusCode, statusMsg?: string) => void;
} {
  if (!isTelemetryEnabled) {
    return {
      context: ROOT_CONTEXT,
      run: (fn) => fn(),
      end: () => {},
    };
  }

  try {
    ensureGlobalContextManager();
    const stringHeaders = normalizeHeaders(headers);
    const extractedContext = propagation.extract(ROOT_CONTEXT, stringHeaders);
    const tracer = getTracer(serviceName);
    const span = tracer.startSpan(spanName, undefined, extractedContext);
    const activeContext = trace.setSpan(extractedContext, span);

    return {
      span,
      context: activeContext,
      run: <T>(fn: () => T) => context.with(activeContext, fn),
      end: (code = SpanStatusCode.OK, msg) => {
        if (code !== SpanStatusCode.OK) {
          span.setStatus({ code, message: msg });
        }
        span.end();
      },
    };
  } catch {
    return {
      context: ROOT_CONTEXT,
      run: (fn) => fn(),
      end: () => {},
    };
  }
}

export async function runWithRequestSpan<T>(
  serviceName: string,
  spanName: string,
  headers: Record<string, string | string[] | undefined>,
  fn: (span?: Span) => Promise<T> | T,
  onTraceContext?: (ctx: { traceId?: string; spanId?: string }) => void
): Promise<T> {
  const { span, run, end } = startSpanFromRequest(serviceName, spanName, headers);
  return run(async () => {
    if (onTraceContext) {
      onTraceContext(getCurrentTraceContext());
    }
    try {
      const result = await fn(span);
      end(SpanStatusCode.OK);
      return result;
    } catch (err: any) {
      end(SpanStatusCode.ERROR, err?.message || 'Request failed');
      throw err;
    }
  });
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
