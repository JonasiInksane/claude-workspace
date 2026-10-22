import { initTRPC } from '@trpc/server';
import { withBilling, withLogin, withTeam } from './access';

const t = initTRPC.create();
export const router = t.router;
export const openProcedure = t.procedure;
export const authedProcedure = t.procedure.use(withLogin);
export const teamProcedure = authedProcedure.use(withTeam);
export const billingProcedure = teamProcedure.use(withBilling);
console.warn('builders ready');
