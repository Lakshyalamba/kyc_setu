import { z } from 'zod';
import { verhoeffValidate } from '../verhoeff.js';

export const INDIAN_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
] as const;

export const UNION_TERRITORIES = [
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
] as const;

export const STATES_AND_UTS = [...INDIAN_STATES, ...UNION_TERRITORIES] as const;
export const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'] as const;
export const OCCUPATIONS = [
  'SALARIED',
  'SELF_EMPLOYED',
  'BUSINESS',
  'PROFESSIONAL',
  'STUDENT',
  'HOMEMAKER',
  'RETIRED',
  'OTHER',
] as const;
export const INCOME_BANDS = [
  'BELOW_1_LAKH',
  '1_TO_5_LAKH',
  '5_TO_10_LAKH',
  '10_TO_25_LAKH',
  'ABOVE_25_LAKH',
] as const;

export const MIN_AGE = 18;
export const MAX_AGE = 100;

/** Unicode letters (+ combining marks, needed for Indic scripts), spaces and dots. Must start with a letter. */
const NAME_REGEX = /^[\p{L}\p{M}][\p{L}\p{M} .]*$/u;
const nameSchema = z
  .string()
  .trim()
  .min(3, 'Must be at least 3 characters')
  .max(100, 'Must be at most 100 characters')
  .regex(NAME_REGEX, 'Only letters, spaces and dots are allowed');

/** Whole years between an ISO date (YYYY-MM-DD) and `today`. Returns null for invalid dates. */
export function ageOn(isoDate: string, today: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
    return null;
  let age = today.getUTCFullYear() - y;
  const beforeBirthday =
    today.getUTCMonth() < mo - 1 || (today.getUTCMonth() === mo - 1 && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

const dateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .superRefine((value, ctx) => {
    const age = ageOn(value, new Date());
    // A wrongly formatted value already failed the regex above; don't report a second issue.
    if (age === null && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    if (age === null) ctx.addIssue({ code: 'custom', message: 'Enter a valid date' });
    else if (age < MIN_AGE)
      ctx.addIssue({ code: 'custom', message: `You must be at least ${MIN_AGE}` });
    else if (age > MAX_AGE)
      ctx.addIssue({ code: 'custom', message: 'Enter a valid date of birth' });
  });

export const addressSchema = z.object({
  line1: z.string().trim().min(3, 'Enter your address').max(100),
  line2: z.string().trim().max(100).optional(),
  city: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u, 'Enter a valid city'),
  state: z.enum(STATES_AND_UTS),
  pincode: z.string().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit pincode'),
});

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const mobileSchema = z
  .string()
  .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');
export const panNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid PAN (e.g. ABCDE1234F)');
export const aadhaarNumberSchema = z
  .string()
  .regex(/^[2-9]\d{11}$/, 'Enter a valid 12-digit Aadhaar number')
  .refine(verhoeffValidate, 'Aadhaar number is not valid');

export const personalDetailsSchema = z.object({
  fullName: nameSchema,
  dateOfBirth: dateOfBirthSchema,
  gender: z.enum(GENDERS),
  fatherName: nameSchema,
  address: addressSchema,
  email: emailSchema,
  mobile: mobileSchema,
  panNumber: panNumberSchema,
  aadhaarNumber: aadhaarNumberSchema,
  occupation: z.enum(OCCUPATIONS),
  annualIncome: z.enum(INCOME_BANDS),
});
export type PersonalDetails = z.infer<typeof personalDetailsSchema>;

/**
 * Body of PATCH /personal. Every field optional, unknown keys rejected. `email` and `mobile` come
 * from the verified Contact step and cannot be changed here.
 */
export const personalDraftSchema = z.strictObject({
  ...personalDetailsSchema.omit({ email: true, mobile: true, address: true }).partial().shape,
  address: addressSchema.partial().optional(),
});
export type PersonalDraft = z.infer<typeof personalDraftSchema>;

/** What the API returns: Aadhaar is never returned in full. */
export const personalResponseSchema = z.object({
  ...personalDetailsSchema.omit({ aadhaarNumber: true, address: true }).partial().shape,
  address: addressSchema.partial().optional(),
  aadhaarMasked: z.string().optional(),
});
export type PersonalResponse = z.infer<typeof personalResponseSchema>;

/** `123456781234` -> `XXXX-XXXX-1234` */
export function maskAadhaar(aadhaar: string): string {
  const digits = aadhaar.replace(/\D/g, '');
  return `XXXX-XXXX-${digits.length >= 4 ? digits.slice(-4) : 'XXXX'}`;
}
