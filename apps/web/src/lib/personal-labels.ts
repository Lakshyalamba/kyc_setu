import type { GENDERS, INCOME_BANDS, OCCUPATIONS } from '@kyc-setu/shared';

export const GENDER_LABEL: Record<(typeof GENDERS)[number], string> = {
  MALE: 'Male',
  FEMALE: 'Female',
  OTHER: 'Other',
  PREFER_NOT_TO_SAY: 'Prefer not to say',
};

export const OCCUPATION_LABEL: Record<(typeof OCCUPATIONS)[number], string> = {
  SALARIED: 'Salaried',
  SELF_EMPLOYED: 'Self-employed',
  BUSINESS: 'Business owner',
  PROFESSIONAL: 'Professional (doctor, CA, lawyer…)',
  STUDENT: 'Student',
  HOMEMAKER: 'Homemaker',
  RETIRED: 'Retired',
  OTHER: 'Other',
};

export const INCOME_LABEL: Record<(typeof INCOME_BANDS)[number], string> = {
  BELOW_1_LAKH: 'Below ₹1 lakh',
  '1_TO_5_LAKH': '₹1–5 lakh',
  '5_TO_10_LAKH': '₹5–10 lakh',
  '10_TO_25_LAKH': '₹10–25 lakh',
  ABOVE_25_LAKH: 'Above ₹25 lakh',
};
