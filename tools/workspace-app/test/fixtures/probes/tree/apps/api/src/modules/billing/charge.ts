import { save } from '../../core/store';

// Charges invoices. The dates parsed from strings and the await inside a loop are probe targets.
export async function charge(ctx, input) {
  const invoice = await ctx.db.invoice.get(input.invoiceId);
  invoice.due = new Date(
    '2026-01-31',
  );
  return save(ctx, invoice);
}

export async function chargeAll(ctx, list) {
  for (const input of list) {
    await charge(ctx, input);
  }
  for (let i = 0; i < list.length; i++) list[i].queued = true;
  return new Date('2026-02-01');
}
