import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics in the text format. Nothing scrapes them yet; /metrics is ready for when something does.
 * Label values are always from closed sets (statuses, decisions, route patterns): never ids, names or numbers
 * taken from a request.
 */
export const registry = new Registry();
registry.setDefaultLabels({ service: 'kyc-api' });
collectDefaultMetrics({ register: registry });

export const stateTransitions = new Counter({
  name: 'kyc_state_transitions_total',
  help: 'KYC session status changes',
  labelNames: ['from', 'to'],
  registers: [registry],
});

export const decisionOutcomes = new Counter({
  name: 'kyc_decisions_total',
  help: 'Officer decisions',
  labelNames: ['decision'],
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by route pattern',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const extractLatency = new Histogram({
  name: 'kyc_extract_latency_seconds',
  help: 'Time the AI service took to answer an extraction call, as seen by the worker',
  labelNames: ['outcome'],
  buckets: [0.5, 1, 2, 5, 10, 20, 40, 60],
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'kyc_queue_depth',
  help: 'Jobs per queue and state',
  labelNames: ['queue', 'state'],
  registers: [registry],
});

export type QueueDepthSource = () => Promise<Record<string, Record<string, number>>>;

/** Fills the queue gauge from Redis each time the endpoint is scraped. */
export async function refreshQueueDepth(source: QueueDepthSource | undefined): Promise<void> {
  if (!source) return;
  try {
    const all = await source();
    for (const [queue, counts] of Object.entries(all)) {
      for (const [state, n] of Object.entries(counts)) queueDepth.set({ queue, state }, n);
    }
  } catch {
    // A scrape must not fail because Redis is down; the readiness probe reports that.
  }
}
