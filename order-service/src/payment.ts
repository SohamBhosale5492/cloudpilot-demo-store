import crypto from 'node:crypto';

export interface PaymentRequest {
  orderId: string;
  amount: number;
  paymentMethod: string;
  cardNumber?: string;
  forceChaosFailure?: boolean;
}

export interface PaymentResult {
  success: boolean;
  paymentReference?: string;
  failureReason?: string;
  processedAt: string;
}

let simulatedPaymentChaosActive = false;

export function setPaymentChaos(active: boolean) {
  simulatedPaymentChaosActive = active;
}

export function isPaymentChaosActive(): boolean {
  return simulatedPaymentChaosActive;
}

export async function processPayment(req: PaymentRequest): Promise<PaymentResult> {
  const processedAt = new Date().toISOString();

  // Artificial processing latency to simulate payment gateway call (30-80ms)
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Check chaos trigger or card-based trigger
  if (req.forceChaosFailure || simulatedPaymentChaosActive) {
    return {
      success: false,
      failureReason: 'PAYMENT_GATEWAY_DECLINED: Simulated card issuer fraud check failure',
      processedAt,
    };
  }

  if (req.cardNumber?.startsWith('9999') || req.cardNumber?.startsWith('4002')) {
    return {
      success: false,
      failureReason: 'CARD_DECLINED: Insufficient funds or invalid card credentials',
      processedAt,
    };
  }

  if (req.amount <= 0) {
    return {
      success: false,
      failureReason: 'INVALID_AMOUNT: Order total must be greater than zero',
      processedAt,
    };
  }

  const paymentReference = `pay_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  return {
    success: true,
    paymentReference,
    processedAt,
  };
}
