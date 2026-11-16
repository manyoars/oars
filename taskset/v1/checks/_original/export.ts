// The CSV export of the requests, served at GET /api/requests.csv.
import type { DatabaseSync } from 'node:sqlite';
import { toCsv } from './lib/csv.ts';
import type { CsvValue } from './lib/csv.ts';
import { formatCents } from './lib/money.ts';

export const EXPORT_STATUSES = ['pending', 'approved', 'rejected', 'delivered'];

interface ExportRow {
  id: number;
  created_at: string;
  handle: string;
  team: string;
  sku: string;
  item: string;
  quantity: number;
  unit_cents: number;
  status: string;
  note: string | null;
}

/** Every request, or those with one status, oldest first, then a row with the count and the totals. */
export const requestsCsv = (db: DatabaseSync, status: string | null): string => {
  if (status !== null && !EXPORT_STATUSES.includes(status)) {
    throw new RangeError(`status must be one of ${EXPORT_STATUSES.join(', ')}`);
  }
  const where = status === null ? '' : 'WHERE r.status = ?';
  const rows = db
    .prepare(
      `SELECT r.id, r.created_at, m.handle, t.name AS team, i.sku, i.name AS item, r.quantity, i.unit_cents,
              r.status, r.note
       FROM requests r
       JOIN members m ON m.id = r.member_id
       JOIN teams t ON t.id = m.team_id
       JOIN items i ON i.id = r.item_id
       ${where}
       ORDER BY r.created_at, r.id`,
    )
    .all(...(status === null ? [] : [status])) as unknown as ExportRow[];
  const header = ['id', 'date', 'member', 'team', 'sku', 'item', 'quantity', 'unit', 'total', 'status', 'note'];
  const lines: CsvValue[][] = [];
  let quantity = 0;
  let cents = 0;
  for (const row of rows) {
    const total = row.quantity * row.unit_cents;
    quantity += row.quantity;
    cents += total;
    lines.push([
      row.id,
      row.created_at.slice(0, 10),
      row.handle,
      row.team,
      row.sku,
      row.item,
      row.quantity,
      formatCents(row.unit_cents),
      formatCents(total),
      row.status,
      row.note,
    ]);
  }
  const noun = rows.length === 1 ? 'request' : 'requests';
  lines.push(['', '', '', '', '', `${rows.length} ${noun}`, quantity, '', formatCents(cents), '', null]);
  return toCsv(header, lines);
};
