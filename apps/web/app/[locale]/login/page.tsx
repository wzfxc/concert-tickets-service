'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { LoginSchema, RegisterSchema } from '@tickets/shared';
import { ErrorText, applyServerErrors } from '../../../src/components/ErrorText';
import { Link, useRouter } from '../../../src/i18n/routing';
import { useAuth } from '../../../src/lib/auth';

const HOME: Record<string, string> = {
  buyer: '/',
  organizer: '/organizer',
  controller: '/controller',
  finance: '/finance',
};

export default function LoginPage() {
  const t = useTranslations('auth');
  const locale = useLocale() as 'uk' | 'en' | 'pl';
  const router = useRouter();
  const { login, register: signUp } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState<unknown>(null);

  type Values = { email: string; password: string; name?: string };
  const form = useForm<Values>({
    resolver: zodResolver(mode === 'login' ? LoginSchema : RegisterSchema) as never,
    defaultValues: { email: '', password: '', name: '' },
  });
  const { register, handleSubmit, formState } = form;

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    try {
      const user =
        mode === 'login'
          ? await login(v.email, v.password)
          : await signUp({ email: v.email, password: v.password, name: v.name ?? '', locale });
      router.push(HOME[user.role] ?? '/');
    } catch (err) {
      setError(err);
      applyServerErrors(err, form.setError as never);
    }
  });

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-4 text-2xl font-semibold">
        {mode === 'login' ? t('loginTitle') : t('registerTitle')}
      </h1>
      <form onSubmit={onSubmit} className="card space-y-3" noValidate>
        {mode === 'register' && (
          <div>
            <label htmlFor="name">{t('name')}</label>
            <input id="name" className="field" autoComplete="name" {...register('name')} />
            {formState.errors.name && (
              <p className="field-error">{formState.errors.name.message}</p>
            )}
          </div>
        )}
        <div>
          <label htmlFor="email">{t('email')}</label>
          <input
            id="email"
            type="email"
            className="field"
            autoComplete="email"
            {...register('email')}
          />
          {formState.errors.email && (
            <p className="field-error">{formState.errors.email.message}</p>
          )}
        </div>
        <div>
          <label htmlFor="password">{t('password')}</label>
          <input
            id="password"
            type="password"
            className="field"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            {...register('password')}
          />
          {formState.errors.password && (
            <p className="field-error">{formState.errors.password.message}</p>
          )}
        </div>
        <ErrorText error={error} />
        <button type="submit" className="btn w-full" disabled={formState.isSubmitting}>
          {t('submit')}
        </button>
        <button
          type="button"
          className="text-sm text-indigo-700 underline"
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? t('toRegister') : t('toLogin')}
        </button>
        <p className="text-xs text-gray-500">{t('hint')}</p>
      </form>
      <Link href="/" className="mt-4 inline-block text-sm text-gray-600">
        ←
      </Link>
    </div>
  );
}

export type LoginValues = z.infer<typeof LoginSchema>;
