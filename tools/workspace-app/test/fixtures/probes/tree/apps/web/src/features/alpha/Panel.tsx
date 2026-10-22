'use client';
import { helper } from '@/features/beta/internal/helper';
import { betaApi } from '@/features/beta';
import { thing } from '../gamma/thing';
import { pub } from '@/features/gamma/public';
import { own } from './own';
import { shared } from '@/lib/shared';
import type { Shared } from '@/features/types';

export function Panel(props: Shared) {
  return helper(betaApi, thing, pub, own, shared, props) as never;
}
