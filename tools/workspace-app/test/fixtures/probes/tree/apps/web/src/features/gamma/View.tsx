"use client";
import '@/features/alpha/public.ts';
import { own } from '@/features/alpha/own.ts';

export const View = () => {
  const a = own as never;
  const b = a as never;
  return b;
};
