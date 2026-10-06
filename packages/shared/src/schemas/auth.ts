import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../constants.js';
import { roleSchema } from './common.js';

const email = z.string().trim().toLowerCase().email().max(254);

export const signupRequestSchema = z.object({
  email,
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

// Login does not enforce min length: we never want to leak password policy via validation errors.
export const loginRequestSchema = z.object({
  email,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const userDtoSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: roleSchema,
  createdAt: z.string().datetime(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

export const authResponseSchema = z.object({ user: userDtoSchema });
export type AuthResponse = z.infer<typeof authResponseSchema>;
