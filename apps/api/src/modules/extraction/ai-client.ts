import {
  faceMatchResponseSchema,
  motionCheckResponseSchema,
  extractResponseSchema,
  type FaceMatchRequest,
  type FaceMatchResponse,
  type MotionCheckRequest,
  type MotionCheckResponse,
  type ExtractionDocumentType,
  type ExtractResponse,
} from '@kyc-setu/shared';
import type { Env } from '../../config/env.js';
import { currentContext } from '../../observability/context.js';
import { extractLatency } from '../../observability/metrics.js';

/** Why a call to the AI service failed, and whether trying again could help. */
export class AiServiceError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AiServiceError';
  }
}

export interface ExtractRequest {
  type: ExtractionDocumentType;
  documentId: string;
  sessionId: string;
  signedUrl: string;
  /** Short-lived token the AI service forwards to the file proxy. */
  serviceToken: string;
}

export interface AiClient {
  extract(req: ExtractRequest): Promise<ExtractResponse>;
  /** The motion check on three frames. Every URL is a short-lived signed link the service fetches. */
  motionCheck(req: MotionCheckRequest, serviceToken: string): Promise<MotionCheckResponse>;
  /** The face on the ID against the face in the selfie. Returns evidence (score, crops, embeddings), not a decision. */
  faceMatch(req: FaceMatchRequest, serviceToken: string): Promise<FaceMatchResponse>;
}

export function createHttpAiClient(
  env: Pick<Env, 'AI_SERVICE_URL' | 'AI_INTERNAL_KEY' | 'AI_REQUEST_TIMEOUT_MS'>,
  fetchImpl: typeof fetch = fetch,
): AiClient {
  const client: AiClient = {
    async extract(req) {
      const aadhaar = req.type !== 'PAN';
      let res: Response;
      try {
        res = await fetchImpl(`${env.AI_SERVICE_URL}/extract/${aadhaar ? 'aadhaar' : 'pan'}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': env.AI_INTERNAL_KEY,
            'X-Fetch-Authorization': `Bearer ${req.serviceToken}`,
            ...(currentContext() ? { 'X-Request-Id': currentContext()!.requestId } : {}),
          },
          body: JSON.stringify({
            documentId: req.documentId,
            sessionId: req.sessionId,
            signedUrl: req.signedUrl,
            ...(aadhaar ? { documentType: req.type } : {}),
          }),
          signal: AbortSignal.timeout(env.AI_REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // Connection refused, DNS, timeout, container killed mid-request: all worth retrying.
        throw new AiServiceError(`AI service unreachable (${(err as Error).name})`, true);
      }

      if (!res.ok) {
        // 5xx (including 503 "models loading") and 502 (document fetch failed) may succeed later; other
        // 4xx mean this request will never succeed.
        const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        throw new AiServiceError(`AI service returned HTTP ${res.status}`, retryable, res.status);
      }
      const parsed = extractResponseSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success)
        throw new AiServiceError('AI service response violated the contract', false, res.status);
      if (parsed.data.documentId !== req.documentId) {
        throw new AiServiceError('AI service answered for a different document', false, res.status);
      }
      return parsed.data;
    },

    async motionCheck(req, serviceToken) {
      const body = await postJson('/face/liveness', req, serviceToken);
      const parsed = motionCheckResponseSchema.safeParse(body);
      if (!parsed.success || parsed.data.captureId !== req.captureId)
        throw new AiServiceError('AI service response violated the contract', false);
      return parsed.data;
    },

    async faceMatch(req, serviceToken) {
      const body = await postJson('/face/match', req, serviceToken);
      const parsed = faceMatchResponseSchema.safeParse(body);
      if (
        !parsed.success ||
        parsed.data.selfieCaptureId !== req.selfieCaptureId ||
        parsed.data.idDocumentId !== req.idDocumentId
      )
        throw new AiServiceError('AI service response violated the contract', false);
      return parsed.data;
    },
  };

  /** One JSON POST to the service with the shared secret and the caller's request id; maps failures like `extract` does. */
  async function postJson(path: string, payload: unknown, serviceToken: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${env.AI_SERVICE_URL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': env.AI_INTERNAL_KEY,
          'X-Fetch-Authorization': `Bearer ${serviceToken}`,
          ...(currentContext() ? { 'X-Request-Id': currentContext()!.requestId } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(env.AI_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new AiServiceError(`AI service unreachable (${(err as Error).name})`, true);
    }
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      throw new AiServiceError(`AI service returned HTTP ${res.status}`, retryable, res.status);
    }
    return res.json().catch(() => null);
  }
  // Wall time of the call as the worker sees it (includes the service fetching the document).
  return {
    async extract(req) {
      const started = process.hrtime.bigint();
      const seconds = () => Number(process.hrtime.bigint() - started) / 1e9;
      try {
        const out = await client.extract(req);
        extractLatency.observe({ outcome: 'ok' }, seconds());
        return out;
      } catch (err) {
        extractLatency.observe({ outcome: 'error' }, seconds());
        throw err;
      }
    },
    motionCheck: (req, token) => client.motionCheck(req, token),
    faceMatch: (req, token) => client.faceMatch(req, token),
  };
}
