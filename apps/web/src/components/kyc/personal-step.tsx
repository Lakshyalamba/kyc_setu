'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, type FieldError } from 'react-hook-form';
import { z } from 'zod';
import {
  GENDERS,
  INCOME_BANDS,
  OCCUPATIONS,
  STATES_AND_UTS,
  addressSchema,
  personalDetailsSchema,
  personalDraftSchema,
  type KycSessionDto,
  type PersonalDraft,
} from '@kyc-setu/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ApiError } from '@/lib/api';
import { kycClient } from '@/lib/kyc-api';
import { stepPath } from '@/lib/kyc-steps';
import { GENDER_LABEL, INCOME_LABEL, OCCUPATION_LABEL } from '@/lib/personal-labels';

type FormValues = z.input<typeof personalDetailsSchema>;
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const AUTOSAVE_MS = 2000;
const TOP_LEVEL_KEYS = [
  'fullName',
  'dateOfBirth',
  'gender',
  'fatherName',
  'panNumber',
  'aadhaarNumber',
  'occupation',
  'annualIncome',
] as const;
const ADDRESS_KEYS = ['line1', 'line2', 'city', 'state', 'pincode'] as const;

/** Flat `key -> value` view of what the server already has, used to send only real changes. */
function snapshotOf(session: KycSessionDto): Record<string, string> {
  const pd = session.personalDetails;
  const snap: Record<string, string> = {};
  if (!pd) return snap;
  for (const k of TOP_LEVEL_KEYS) {
    const v = (pd as Record<string, unknown>)[k];
    if (typeof v === 'string') snap[k] = v;
  }
  for (const k of ADDRESS_KEYS) {
    const v = pd.address?.[k];
    if (typeof v === 'string') snap[`address.${k}`] = v;
  }
  return snap;
}

/** Only fields that currently pass validation are autosaved; half-typed values wait. */
function collectChanges(
  values: FormValues,
  saved: Record<string, string>,
  includeAadhaar: boolean,
): { draft: PersonalDraft; flat: Record<string, string> } {
  const draft: Record<string, unknown> = {};
  const flat: Record<string, string> = {};

  for (const key of TOP_LEVEL_KEYS) {
    if (key === 'aadhaarNumber' && !includeAadhaar) continue;
    const raw = values[key];
    if (typeof raw !== 'string' || raw === '') continue;
    const parsed = personalDraftSchema.shape[key].safeParse(raw);
    if (!parsed.success || typeof parsed.data !== 'string') continue;
    if (saved[key] === parsed.data) continue;
    draft[key] = parsed.data;
    flat[key] = parsed.data;
  }

  const address: Record<string, string> = {};
  for (const key of ADDRESS_KEYS) {
    const raw = values.address?.[key];
    if (typeof raw !== 'string' || raw === '') continue;
    const parsed = addressSchema.shape[key].safeParse(raw);
    if (!parsed.success || typeof parsed.data !== 'string') continue;
    if (saved[`address.${key}`] === parsed.data) continue;
    address[key] = parsed.data;
    flat[`address.${key}`] = parsed.data;
  }
  if (Object.keys(address).length > 0) draft['address'] = address;

  return { draft: draft as PersonalDraft, flat };
}

/** zod's default enum message is unfriendly for an empty <select>. */
const msg = (e: FieldError | undefined): string | undefined =>
  e ? (e.message?.startsWith('Invalid option') ? 'Please select an option' : e.message) : undefined;

const digitsOnly = (max: number) => ({
  onChange: (e: { target: HTMLInputElement }) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, max);
  },
});

export function PersonalStep({ session }: { session: KycSessionDto }) {
  const router = useRouter();
  const pd = session.personalDetails;
  const hasStoredAadhaar = Boolean(pd?.aadhaarMasked);
  const [changingAadhaar, setChangingAadhaar] = useState(!hasStoredAadhaar);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [formError, setFormError] = useState<string | null>(null);

  // If Aadhaar is already saved (and shown masked), the field isn't required unless the user changes it.
  const schema = useMemo(
    () =>
      changingAadhaar
        ? personalDetailsSchema
        : (personalDetailsSchema.extend({
            aadhaarNumber: z.string().optional(),
            // Same shape as the real schema for typing purposes.
          }) as unknown as typeof personalDetailsSchema),
    [changingAadhaar],
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: {
      fullName: pd?.fullName ?? '',
      dateOfBirth: pd?.dateOfBirth ?? '',
      gender: pd?.gender,
      fatherName: pd?.fatherName ?? '',
      address: {
        line1: pd?.address?.line1 ?? '',
        line2: pd?.address?.line2 ?? '',
        city: pd?.address?.city ?? '',
        state: pd?.address?.state,
        pincode: pd?.address?.pincode ?? '',
      },
      email: session.contact.email ?? '',
      mobile: session.contact.mobile ?? '',
      panNumber: pd?.panNumber ?? '',
      aadhaarNumber: '',
      occupation: pd?.occupation,
      annualIncome: pd?.annualIncome,
    },
  });
  const { register, handleSubmit, getValues, watch, formState } = form;
  const errors = formState.errors;

  const saved = useRef<Record<string, string>>(snapshotOf(session));
  const queue = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const includeAadhaar = useRef(changingAadhaar);
  includeAadhaar.current = changingAadhaar;

  /** Serialised so two saves never race. Rejects if the save fails. */
  function saveNow(): Promise<void> {
    const run = async () => {
      const { draft, flat } = collectChanges(getValues(), saved.current, includeAadhaar.current);
      if (Object.keys(flat).length === 0) return;
      setSaveState('saving');
      try {
        await kycClient.patchPersonal(session.id, draft);
        Object.assign(saved.current, flat);
        setSaveState('saved');
      } catch (err) {
        setSaveState('error');
        throw err;
      }
    };
    const next = queue.current.catch(() => undefined).then(run);
    queue.current = next;
    return next;
  }

  useEffect(() => {
    const sub = watch(() => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void saveNow().catch(() => undefined), AUTOSAVE_MS);
    });
    return () => {
      sub.unsubscribe();
      clearTimeout(timer.current);
    };
    // saveNow only reads refs and stable setters, so it is safe to omit from deps.
  }, [watch]);

  async function onValid() {
    setFormError(null);
    clearTimeout(timer.current);
    try {
      await saveNow();
      const { session: next } = await kycClient.submitPersonal(session.id);
      router.push(stepPath(next.currentStep));
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && Array.isArray(err.details)) {
        for (const issue of err.details as { path?: string; message?: string }[]) {
          if (issue.path) form.setError(issue.path as never, { message: issue.message });
        }
        setFormError('Please fix the highlighted fields.');
      } else {
        setFormError(
          err instanceof ApiError && err.status < 500
            ? err.message
            : 'Something went wrong. Please try again.',
        );
      }
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Personal details</CardTitle>
        <CardDescription>
          Enter these as they appear on your PAN and Aadhaar. We save as you type, so you can leave
          and come back.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onValid)} className="flex flex-col gap-5" noValidate>
          <Field label="Full name" htmlFor="fullName" error={msg(errors.fullName)}>
            <Input id="fullName" autoComplete="name" {...register('fullName')} />
          </Field>
          <Field label="Date of birth" htmlFor="dateOfBirth" error={msg(errors.dateOfBirth)}>
            <Input id="dateOfBirth" type="date" autoComplete="bday" {...register('dateOfBirth')} />
          </Field>
          <Field label="Gender" htmlFor="gender" error={msg(errors.gender)}>
            <Select id="gender" defaultValue="" {...register('gender')}>
              <option value="" disabled>
                Select…
              </option>
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {GENDER_LABEL[g]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Father's name" htmlFor="fatherName" error={msg(errors.fatherName)}>
            <Input id="fatherName" {...register('fatherName')} />
          </Field>

          <fieldset className="flex flex-col gap-5">
            <legend className="mb-1 text-sm font-semibold">Address</legend>
            <Field label="Address line 1" htmlFor="line1" error={msg(errors.address?.line1)}>
              <Input id="line1" autoComplete="address-line1" {...register('address.line1')} />
            </Field>
            <Field
              label="Address line 2 (optional)"
              htmlFor="line2"
              error={msg(errors.address?.line2)}
            >
              <Input id="line2" autoComplete="address-line2" {...register('address.line2')} />
            </Field>
            <Field label="City" htmlFor="city" error={msg(errors.address?.city)}>
              <Input id="city" autoComplete="address-level2" {...register('address.city')} />
            </Field>
            <Field label="State / UT" htmlFor="state" error={msg(errors.address?.state)}>
              <Select id="state" defaultValue="" {...register('address.state')}>
                <option value="" disabled>
                  Select…
                </option>
                {STATES_AND_UTS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Pincode" htmlFor="pincode" error={msg(errors.address?.pincode)}>
              <Input
                id="pincode"
                inputMode="numeric"
                autoComplete="postal-code"
                maxLength={6}
                {...register('address.pincode', digitsOnly(6))}
              />
            </Field>
          </fieldset>

          <fieldset className="flex flex-col gap-5">
            <legend className="mb-1 text-sm font-semibold">Contact (verified)</legend>
            <Field label="Mobile number" htmlFor="mobile-ro">
              <Input id="mobile-ro" readOnly className="bg-secondary" {...register('mobile')} />
            </Field>
            <Field label="Email address" htmlFor="email-ro">
              <Input id="email-ro" readOnly className="bg-secondary" {...register('email')} />
            </Field>
          </fieldset>

          <fieldset className="flex flex-col gap-5">
            <legend className="mb-1 text-sm font-semibold">Identity numbers</legend>
            <Field
              label="PAN"
              htmlFor="panNumber"
              error={msg(errors.panNumber)}
              hint="10 characters, e.g. ABCDE1234F"
            >
              <Input
                id="panNumber"
                autoCapitalize="characters"
                autoComplete="off"
                maxLength={10}
                className="font-mono uppercase"
                {...register('panNumber', {
                  onChange: (e) => {
                    e.target.value = e.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
                  },
                })}
              />
            </Field>
            {changingAadhaar ? (
              <Field
                label="Aadhaar number"
                htmlFor="aadhaarNumber"
                error={msg(errors.aadhaarNumber)}
                hint="12 digits. We store it encrypted and only ever show the last 4."
              >
                <Input
                  id="aadhaarNumber"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={12}
                  className="font-mono"
                  {...register('aadhaarNumber', digitsOnly(12))}
                />
              </Field>
            ) : (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Aadhaar number</span>
                <div className="flex items-center justify-between gap-3">
                  <span data-testid="aadhaar-masked" className="font-mono text-base">
                    {pd?.aadhaarMasked}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      form.setValue('aadhaarNumber', '');
                      setChangingAadhaar(true);
                    }}
                  >
                    Change
                  </Button>
                </div>
              </div>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-5">
            <legend className="mb-1 text-sm font-semibold">Occupation</legend>
            <Field label="Occupation" htmlFor="occupation" error={msg(errors.occupation)}>
              <Select id="occupation" defaultValue="" {...register('occupation')}>
                <option value="" disabled>
                  Select…
                </option>
                {OCCUPATIONS.map((o) => (
                  <option key={o} value={o}>
                    {OCCUPATION_LABEL[o]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Annual income" htmlFor="annualIncome" error={msg(errors.annualIncome)}>
              <Select id="annualIncome" defaultValue="" {...register('annualIncome')}>
                <option value="" disabled>
                  Select…
                </option>
                {INCOME_BANDS.map((b) => (
                  <option key={b} value={b}>
                    {INCOME_LABEL[b]}
                  </option>
                ))}
              </Select>
            </Field>
          </fieldset>

          <p
            data-testid="save-state"
            aria-live="polite"
            className="min-h-5 text-sm text-muted-foreground"
          >
            {saveState === 'saving' && 'Saving…'}
            {saveState === 'saved' && 'All changes saved'}
            {saveState === 'error' && 'Couldn’t save your changes. We’ll retry.'}
          </p>
          <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">
            {formError}
          </p>
          <Button type="submit" size="lg" disabled={formState.isSubmitting}>
            {formState.isSubmitting ? 'Saving…' : 'Save & Continue'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
