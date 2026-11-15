export interface ChaosConfig {
  latencyMs: number;
  errorRate: number;
  force500: boolean;
  active: boolean;
}

const currentChaos: ChaosConfig = {
  latencyMs: 0,
  errorRate: 0,
  force500: false,
  active: false,
};

export function getChaosConfig(): ChaosConfig {
  return { ...currentChaos };
}

export function injectChaos(params: Partial<ChaosConfig>) {
  if (params.latencyMs !== undefined) currentChaos.latencyMs = Math.max(0, params.latencyMs);
  if (params.errorRate !== undefined) currentChaos.errorRate = Math.min(1, Math.max(0, params.errorRate));
  if (params.force500 !== undefined) currentChaos.force500 = params.force500;
  currentChaos.active = currentChaos.latencyMs > 0 || currentChaos.errorRate > 0 || currentChaos.force500;
  return getChaosConfig();
}

export function resetChaos(): ChaosConfig {
  currentChaos.latencyMs = 0;
  currentChaos.errorRate = 0;
  currentChaos.force500 = false;
  currentChaos.active = false;
  return getChaosConfig();
}

export async function applyChaosMiddleware(): Promise<{ shouldFail500: boolean; errorMsg?: string }> {
  if (!currentChaos.active) {
    return { shouldFail500: false };
  }

  // Artificial latency
  if (currentChaos.latencyMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, currentChaos.latencyMs));
  }

  // Forced 500 error
  if (currentChaos.force500) {
    return { shouldFail500: true, errorMsg: 'Simulated API Gateway Chaos 500 Fault' };
  }

  // Probabilistic 500 error
  if (currentChaos.errorRate > 0 && Math.random() < currentChaos.errorRate) {
    return { shouldFail500: true, errorMsg: 'Simulated Probabilistic 500 Failure' };
  }

  return { shouldFail500: false };
}
