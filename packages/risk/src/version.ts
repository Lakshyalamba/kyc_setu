/**
 * Bump this whenever a rule, a weight, a threshold, the band table or the engine logic changes.
 * It is stored on every RiskAssessment, so an old score can always be explained by the rules that made it.
 * `test/version-lock.test.ts` enforces it; update ENGINE_LOCK.json with `pnpm --filter @kyc-setu/risk lock`.
 */
export const ENGINE_VERSION = '1.0.0';
