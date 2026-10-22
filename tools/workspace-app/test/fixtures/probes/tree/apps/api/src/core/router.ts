import { billingRouter } from '../modules/billing/router';
import { teamsRouter } from '../modules/teams/router';
import { openProcedure, router } from './trpc';

export const appRouter = router({
  health: openProcedure.query(() => 'ok'),
  billing: billingRouter,
  teams: teamsRouter,
});
