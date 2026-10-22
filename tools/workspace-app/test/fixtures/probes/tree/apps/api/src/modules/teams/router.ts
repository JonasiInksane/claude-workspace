import { z } from 'zod';
import { ensureMember } from '../../core/access';
import { authedProcedure, openProcedure, router, teamProcedure, weirdProcedure } from '../../core/trpc';

export const teamsRouter = router({
  mine: authedProcedure.query(({ ctx }) => ctx.db.team.findMany({ where: { ownerId: ctx.user.id } })),
  byId: teamProcedure
    .input(z.object({ teamId: z.number() }))
    .query(async ({ ctx, input }) => {
      ensureMember(ctx, input.teamId);
      return ctx.db.team.get(input.teamId);
    }),
  members: router({
    list: teamProcedure
      .input(z.object({ teamId: z.number() }))
      .query(({ ctx, input }) => ctx.db.member.findMany({ where: { teamId: input.teamId } })),
    invite: openProcedure
      .input(z.object({ teamId: z.number(), email: z.string() }))
      .mutation(({ ctx, input }) => ctx.invite(input)),
  }),
  legacy: weirdProcedure.query(() => null),
  settings: settingsRouter,
});

const founded = new Date('2024-01-01');
