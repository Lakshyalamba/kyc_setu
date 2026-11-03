import { describe, expect, it } from 'vitest';
import { AiServiceError, createHttpAiClient } from '../src/modules/extraction/ai-client.js';
import { matchResponse, motionResponse } from './helpers.js';

const env = {
  AI_SERVICE_URL: 'http://ai.test',
  AI_INTERNAL_KEY: 'k'.repeat(32),
  AI_REQUEST_TIMEOUT_MS: 5000,
};
const ID = '3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13';
const DOC = '7b1d3c5e-1111-4222-8333-444455556666';
const motionReq = {
  captureId: ID,
  frameUrls: ['http://a/1', 'http://a/2', 'http://a/3'],
  bestFrameUrl: 'http://a/b',
};
const matchReq = {
  selfieCaptureId: ID,
  selfieBestUrl: 'http://a/b',
  idDocumentId: DOC,
  idDocumentUrl: 'http://a/d',
};

const reply = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('the face calls of the AI client', () => {
  it('post to /face/liveness and /face/match with the shared secret and the service token, and parse the answer', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(
        JSON.stringify(url.endsWith('liveness') ? motionResponse(ID) : matchResponse(ID, DOC)),
      );
    }) as unknown as typeof fetch;
    const client = createHttpAiClient(env, fetchImpl);
    expect((await client.motionCheck(motionReq, 'tok')).result).toBe('PASSED');
    expect((await client.faceMatch(matchReq, 'tok')).score).toBe(0.8);
    expect(seen.map((s) => s.url)).toEqual([
      'http://ai.test/face/liveness',
      'http://ai.test/face/match',
    ]);
    expect(seen[0]!.headers).toMatchObject({
      'X-Internal-Key': env.AI_INTERNAL_KEY,
      'X-Fetch-Authorization': 'Bearer tok',
    });
  });

  it('refuses an answer for a different capture or document, and one that breaks the contract (not retryable)', async () => {
    const wrongCapture = createHttpAiClient(env, reply(motionResponse(DOC)));
    await expect(wrongCapture.motionCheck(motionReq, 't')).rejects.toMatchObject({
      retryable: false,
    });
    const wrongDoc = createHttpAiClient(env, reply(matchResponse(ID, ID)));
    await expect(wrongDoc.faceMatch(matchReq, 't')).rejects.toBeInstanceOf(AiServiceError);
    const broken = createHttpAiClient(env, reply({ score: 7 }));
    await expect(broken.faceMatch(matchReq, 't')).rejects.toMatchObject({ retryable: false });
  });

  it('treats a 503 (models loading) and a refused connection as retryable, and a 422 as final', async () => {
    await expect(
      createHttpAiClient(env, reply({}, 503)).motionCheck(motionReq, 't'),
    ).rejects.toMatchObject({ retryable: true, status: 503 });
    await expect(
      createHttpAiClient(env, reply({}, 422)).faceMatch(matchReq, 't'),
    ).rejects.toMatchObject({ retryable: false, status: 422 });
    const down = createHttpAiClient(env, (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(down.motionCheck(motionReq, 't')).rejects.toMatchObject({ retryable: true });
  });
});
