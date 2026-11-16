// CSV text for the exports, as RFC 4180 has it: a field holding a comma, a double quote, or a line break is quoted,
// and a double quote inside it is doubled.

export type CsvValue = string | number | null;

const NEEDS_QUOTES = /[",\r\n]/;

export const csvField = (value: CsvValue): string => {
  const text = value === null ? '' : String(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** A header row, then one row per record; every line ends with CRLF. */
export const toCsv = (header: string[], rows: CsvValue[][]): string =>
  [header, ...rows].map((row) => `${row.map(csvField).join(',')}\r\n`).join('');
