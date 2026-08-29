import type { InvoiceSummary } from "./contracts.js";

export function invoiceSummary(record: { totalCents: number }): InvoiceSummary {
  return { totalDollars: record.totalCents };
}
