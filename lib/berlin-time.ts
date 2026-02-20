const BERLIN_TIMEZONE = "Europe/Berlin";

export type BerlinNow = {
  berlinDate: string;
  berlinTime: string;
  timezone: "Europe/Berlin";
};

export function getBerlinNow(date = new Date()): BerlinNow {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BERLIN_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    berlinDate: `${map.year}-${map.month}-${map.day}`,
    berlinTime: `${map.hour}:${map.minute}:${map.second}`,
    timezone: BERLIN_TIMEZONE,
  };
}

export function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
