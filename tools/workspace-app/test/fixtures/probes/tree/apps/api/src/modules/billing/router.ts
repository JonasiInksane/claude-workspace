import { z } from 'zod';
import { ensureTeamRole } from '../../core/access';
import { billingProcedure, openProcedure, router, teamProcedure } from '../../core/trpc';
import { charge } from './charge';

export const billingRouter = router({
  list: teamProcedure
    .input(z.object({ teamId: z.number() }))
    .query(async ({ ctx, input }) => {
      ensureTeamRole(ctx, 'staff');
      return ctx.db.invoice.findMany({ where: { teamId: input.teamId } });
    }),
  charge: billingProcedure.input(z.object({ teamId: z.number(), amount: z.number() })).mutation(({ ctx, input }) => charge(ctx, input)),
  refund: teamProcedure
    .input(z.object({ teamId: z.number(), id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.invoice.refund(input.id);
    }),
  publicPrice: openProcedure
    .input(z.object({ teamId: z.number() }))
    .query(({ ctx, input }) => ctx.db.price.findFirst({ where: { teamId: input.teamId } })),
  webhook: openProcedure.mutation(({ ctx }) => ctx.ok()),
});

export const launched = new Date("2025-06-01");
