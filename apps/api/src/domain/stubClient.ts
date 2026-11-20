/** HTTP client for the payment stub: the app talks to the "provider" only over HTTP, like a real PSP. */
export type StubResult<T> =
  { ok: true; data: T } | { ok: false; retryable: boolean; status: number };

export interface StubPayment {
  providerRef: string;
  merchantRef: string;
  amountKop: number;
  status: 'pending' | 'succeeded' | 'failed';
  payUrl: string;
}
export interface StubRefund {
  providerRef: string;
  merchantRef: string;
  paymentRef: string;
  amountKop: number;
  status: 'succeeded' | 'failed';
}

export class StubClient {
  constructor(private readonly baseUrl: string) {}

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: object,
  ): Promise<StubResult<T>> {
    try {
      const res = await fetch(`${this.baseUrl}/stub-pay/api${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true, data: (await res.json()) as T };
      // 429 (rate limit) and 5xx (chaos 503) are transient: the caller retries with backoff.
      return { ok: false, retryable: res.status === 429 || res.status >= 500, status: res.status };
    } catch {
      return { ok: false, retryable: true, status: 0 };
    }
  }

  createPayment(p: { merchantRef: string; amountKop: number; returnUrl?: string }) {
    return this.call<StubPayment>('POST', '/payments', p);
  }
  getPayment(providerRef: string) {
    return this.call<StubPayment>('GET', `/payments/${encodeURIComponent(providerRef)}`);
  }
  createRefund(p: { merchantRef: string; paymentRef: string; amountKop: number }) {
    return this.call<StubRefund>('POST', '/refunds', p);
  }
  getRefund(providerRef: string) {
    return this.call<StubRefund>('GET', `/refunds/${encodeURIComponent(providerRef)}`);
  }
}
