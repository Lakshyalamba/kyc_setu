import { randomUUID } from 'node:crypto';
import type { Env } from '../src/config/env.js';
import { hashPassword } from '../src/lib/password.js';
import type { AuditEntry, AuthStore, UserRecord } from '../src/modules/auth/store.js';
import type { Role } from '@kyc-setu/shared';

export const testEnv = (overrides: Partial<Env> = {}): Env => ({
  NODE_ENV: 'test',
  API_PORT: 4000,
  DATABASE_URL: 'postgresql://x:x@localhost:5432/x',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'a',
  S3_SECRET_KEY: 'b',
  S3_BUCKET: 'kyc-documents',
  JWT_SECRET: 'unit-test-secret-unit-test-secret-1234',
  JWT_EXPIRES_IN_SECONDS: 3600,
  WEB_ORIGIN: 'http://localhost:3000',
  AI_SERVICE_URL: 'http://localhost:8000',
  ...overrides,
});

export interface FakeStore extends AuthStore {
  users: UserRecord[];
  audits: AuditEntry[];
  addUser(email: string, password: string, role: Role): Promise<UserRecord>;
}

export function createFakeStore(): FakeStore {
  const users: UserRecord[] = [];
  const audits: AuditEntry[] = [];
  return {
    users,
    audits,
    async addUser(email, password, role) {
      const user = {
        id: randomUUID(),
        email,
        passwordHash: await hashPassword(password),
        role,
        createdAt: new Date(),
      };
      users.push(user);
      return user;
    },
    findUserByEmail: async (email) => users.find((u) => u.email === email) ?? null,
    findUserById: async (id) => users.find((u) => u.id === id) ?? null,
    async createCustomerWithAudit(input, audit) {
      if (users.some((u) => u.email === input.email)) return null;
      const user: UserRecord = {
        id: randomUUID(),
        ...input,
        role: 'CUSTOMER',
        createdAt: new Date(),
      };
      users.push(user);
      audits.push(audit(user));
      return user;
    },
    async writeAudit(entry) {
      audits.push(entry);
    },
  };
}
