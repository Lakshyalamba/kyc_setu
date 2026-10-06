'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  emailSchema,
  mobileSchema,
  otpVerifyRequestSchema,
  type KycSessionDto,
} from '@kyc-setu/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { DevOtpBanner } from '@/components/kyc/dev-otp-banner';
import { ApiError } from '@/lib/api';
import { kycClient } from '@/lib/kyc-api';
import { stepPath } from '@/lib/kyc-steps';

const detailsSchema = z.object({ mobile: mobileSchema, email: emailSchema });
type DetailsValues = z.infer<typeof detailsSchema>;
type CodeValues = z.infer<typeof otpVerifyRequestSchema>;

const messageFor = (err: unknown): string =>
  err instanceof ApiError && err.status < 500
    ? err.message
    : 'Something went wrong. Please try again.';

export function ContactStep({ session }: { session: KycSessionDto }) {
  const router = useRouter();
  const [sent, setSent] = useState<{ devCode: string | undefined; to: string } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const details = useForm<DetailsValues>({
    resolver: zodResolver(detailsSchema),
    mode: 'onTouched',
    defaultValues: { mobile: session.contact.mobile ?? '', email: session.contact.email ?? '' },
  });
  const code = useForm<CodeValues>({
    resolver: zodResolver(otpVerifyRequestSchema),
    defaultValues: { code: '' },
  });

  async function sendOtp(values: DetailsValues) {
    setServerError(null);
    try {
      const res = await kycClient.sendOtp(session.id, values);
      setSent({ devCode: res.devCode, to: res.destinationMasked });
      code.reset({ code: '' });
    } catch (err) {
      setServerError(messageFor(err));
    }
  }

  async function verify(values: CodeValues) {
    setServerError(null);
    try {
      const { session: next } = await kycClient.verifyOtp(session.id, values.code);
      router.push(stepPath(next.currentStep));
      router.refresh();
    } catch (err) {
      setServerError(messageFor(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Verify your contact</CardTitle>
        <CardDescription>
          We’ll text a 6-digit code to your mobile number to confirm it’s yours.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={details.handleSubmit(sendOtp)} className="flex flex-col gap-4" noValidate>
          <Field
            label="Mobile number"
            htmlFor="mobile"
            error={details.formState.errors.mobile?.message}
          >
            <Input
              id="mobile"
              inputMode="numeric"
              autoComplete="tel-national"
              maxLength={10}
              placeholder="10-digit mobile number"
              readOnly={sent !== null}
              aria-invalid={!!details.formState.errors.mobile}
              {...details.register('mobile', {
                onChange: (e) => {
                  e.target.value = e.target.value.replace(/\D/g, '');
                },
              })}
            />
          </Field>
          <Field
            label="Email address"
            htmlFor="email"
            error={details.formState.errors.email?.message}
          >
            <Input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              readOnly={sent !== null}
              aria-invalid={!!details.formState.errors.email}
              {...details.register('email')}
            />
          </Field>
          <Button
            type="submit"
            variant={sent ? 'outline' : 'default'}
            disabled={details.formState.isSubmitting}
          >
            {details.formState.isSubmitting ? 'Sending…' : sent ? 'Resend OTP' : 'Send OTP'}
          </Button>
        </form>

        {sent && (
          <form onSubmit={code.handleSubmit(verify)} className="flex flex-col gap-4" noValidate>
            <DevOtpBanner code={sent.devCode} />
            <Field
              label={`Enter the code sent to ${sent.to}`}
              htmlFor="code"
              error={code.formState.errors.code?.message}
            >
              <Input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="6-digit code"
                className="text-center font-mono text-xl tracking-[0.5em]"
                {...code.register('code', {
                  onChange: (e) => {
                    e.target.value = e.target.value.replace(/\D/g, '');
                  },
                })}
              />
            </Field>
            <Button type="submit" disabled={code.formState.isSubmitting}>
              {code.formState.isSubmitting ? 'Verifying…' : 'Verify'}
            </Button>
          </form>
        )}

        <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">
          {serverError}
        </p>
      </CardContent>
    </Card>
  );
}
