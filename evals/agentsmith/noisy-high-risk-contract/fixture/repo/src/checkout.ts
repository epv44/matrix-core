import { invoiceSummary } from "./invoice-api.js";

export function chargeAmount(record: { totalCents: number }): number {
  return invoiceSummary(record).totalDollars * 100;
}
