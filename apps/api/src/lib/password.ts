import argon2 from 'argon2';

const OPTIONS = { type: argon2.argon2id } as const;

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain, OPTIONS);

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/** Verified against when the user does not exist, so timing doesn't reveal which emails exist. */
export function burnPasswordCheck(plain: string): Promise<boolean> {
  dummyHash ??= hashPassword('kyc-setu-dummy-password');
  return dummyHash.then((h) => verifyPassword(h, plain));
}
