'use client';

import { useTranslations } from 'next-intl';
import { ApiError } from '../lib/api';

/** Localised message for any failure; unknown errors fall back to INTERNAL. */
export function useErrorMessage(): (err: unknown) => string {
  const t = useTranslations('errors');
  return (err) => {
    if (err instanceof ApiError) return t(err.code);
    return t('INTERNAL');
  };
}

export function ErrorText({ error }: { error: unknown }) {
  const msg = useErrorMessage();
  if (!error) return null;
  return (
    <p
      role="alert"
      className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {msg(error)}
    </p>
  );
}

/** Copies field-level server issues (VALIDATION_ERROR details) onto react-hook-form fields. */
export function applyServerErrors(
  err: unknown,
  setError: (name: never, error: { message: string }) => void,
): void {
  if (!(err instanceof ApiError)) return;
  for (const issue of err.issues) {
    if (issue.path) setError(issue.path.split('.')[0] as never, { message: issue.message });
  }
}
