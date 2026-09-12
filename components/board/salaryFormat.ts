/**
 * Salary display formatting. Minors render as ranges; text-only salaries
 * (hourly/daily rates, unrecognized currencies) pass through verbatim and
 * truncated — the UI never annualizes or invents amounts.
 */

export interface SalaryParts {
  salaryText: string | null;
  salaryCurrency: string | null;
  salaryMinMinor: number | null;
  salaryMaxMinor: number | null;
}

function dollars(minor: number): number {
  return minor / 100;
}

function fullAmount(minor: number): string {
  return `$${dollars(minor).toLocaleString("en-US")}`;
}

function compactAmount(minor: number): string {
  const value = dollars(minor);
  if (value >= 10000) {
    return `$${Math.round(value / 1000)}k`;
  }
  return fullAmount(minor);
}

function verbatimText(text: string | null): string | null {
  if (text === null || text.trim() === "") {
    return null;
  }
  const trimmed = text.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;
}

function withCurrency(range: string, currency: string | null): string {
  return currency === null || currency === "" ? range : `${range} ${currency}`;
}

function rangeOf(
  parts: SalaryParts,
  formatAmount: (minor: number) => string,
): string | null {
  const { salaryMinMinor, salaryMaxMinor, salaryCurrency } = parts;
  if (salaryMinMinor !== null && salaryMaxMinor !== null) {
    if (salaryMinMinor === salaryMaxMinor) {
      return withCurrency(formatAmount(salaryMinMinor), salaryCurrency);
    }
    return withCurrency(
      `${formatAmount(salaryMinMinor)} – ${formatAmount(salaryMaxMinor)}`,
      salaryCurrency,
    );
  }
  if (salaryMinMinor !== null) {
    return withCurrency(`${formatAmount(salaryMinMinor)}+`, salaryCurrency);
  }
  if (salaryMaxMinor !== null) {
    return withCurrency(`up to ${formatAmount(salaryMaxMinor)}`, salaryCurrency);
  }
  return verbatimText(parts.salaryText);
}

/** Compact card badge: `$146k – $197k CAD`, or verbatim text, or null. */
export function formatSalaryBadge(parts: SalaryParts): string | null {
  return rangeOf(parts, compactAmount);
}

/** Full-precision drawer line: `$145,900 – $197,400 CAD`, or verbatim text, or null. */
export function formatSalaryRange(parts: SalaryParts): string | null {
  return rangeOf(parts, fullAmount);
}
