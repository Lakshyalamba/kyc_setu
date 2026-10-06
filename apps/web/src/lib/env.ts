import { z } from 'zod';

const schema = z.object({ NEXT_PUBLIC_API_URL: z.string().url() });

// NEXT_PUBLIC_* vars are inlined at build time, so each must be referenced literally here.
const parsed = schema.safeParse({ NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL });
if (!parsed.success) {
  throw new Error(
    `Invalid web environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
  );
}
export const env = parsed.data;
