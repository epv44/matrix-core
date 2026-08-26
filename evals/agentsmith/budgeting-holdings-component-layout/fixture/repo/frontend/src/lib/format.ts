export function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function money(n: number): string {
  const abs = fmtMoney(Math.abs(n));
  return (n < 0 ? "-$" : "$") + abs;
}
