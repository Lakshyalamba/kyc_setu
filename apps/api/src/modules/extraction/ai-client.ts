import {
  extractResponseSchema,
  type ExtractionDocumentType,
  type ExtractResponse,
} from '@kyc-setu/shared';
import type { Env } from '../../config/env.js';

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
}

export function createHttpAiClient(
  env: Pick<Env, 'AI_SERVICE_URL' | 'AI_INTERNAL_KEY' | 'AI_REQUEST_TIMEOUT_MS'>,
  fetchImpl: typeof fetch = fetch,
): AiClient {
  return {
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
  };
}
