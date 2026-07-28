const arabicNumber = new Intl.NumberFormat("ar-SA", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
  numberingSystem: "latn",
});

const arabicDate = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Riyadh",
  numberingSystem: "latn",
});

export function formatKmh(value: number): string {
  return arabicNumber.format(value);
}

export function formatSaudiDate(value: string): string {
  return arabicDate.format(new Date(value));
}
