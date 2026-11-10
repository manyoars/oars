// Where telemetry is off: a machine whose time zone is in the EU, the EEA, or the UK records and sends nothing, with no prompt (P97). The zone is the machine's own fact, so no network call
// is made. An unresolvable zone counts as closed: the rule fails toward sending nothing.

/** IANA zones of the EU, the EEA (Iceland, Liechtenstein, Norway), and the UK, with the outermost regions that sit outside `Europe/*` and `Europe/Mariehamn` (Åland). */
export const CLOSED_ZONES: ReadonlySet<string> = new Set([
  // EU member states
  'Europe/Vienna', 'Europe/Brussels', 'Europe/Sofia', 'Europe/Zagreb', 'Asia/Nicosia', 'Asia/Famagusta', 'Europe/Nicosia', 'Europe/Prague', 'Europe/Copenhagen',
  'Europe/Tallinn', 'Europe/Helsinki', 'Europe/Mariehamn', 'Europe/Paris', 'Europe/Berlin', 'Europe/Busingen', 'Europe/Athens', 'Europe/Budapest', 'Europe/Dublin',
  'Europe/Rome', 'Europe/Riga', 'Europe/Vilnius', 'Europe/Luxembourg', 'Europe/Malta', 'Europe/Amsterdam', 'Europe/Warsaw', 'Europe/Lisbon', 'Europe/Bucharest',
  'Europe/Bratislava', 'Europe/Ljubljana', 'Europe/Madrid', 'Europe/Stockholm',
  // EEA outside the EU, and the UK (with its legacy aliases)
  'Atlantic/Reykjavik', 'Iceland', 'Europe/Vaduz', 'Europe/Oslo', 'Arctic/Longyearbyen', 'Atlantic/Jan_Mayen', 'WET', 'CET', 'MET', 'EET', 'Europe/London', 'Europe/Belfast', 'Europe/Jersey', 'Europe/Guernsey', 'Europe/Isle_of_Man',
  'GB', 'GB-Eire', 'Eire', 'Portugal', 'Poland',
  // Outermost regions and island zones of member states
  'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores', 'Africa/Ceuta', 'America/Martinique', 'America/Guadeloupe', 'America/Cayenne', 'Indian/Reunion', 'Indian/Mayotte',
  'America/St_Barthelemy', 'America/Marigot',
]);

/** True when the zone is on the closed list or cannot be read (absent or blank). */
export const isClosedZone = (zone: string | undefined): boolean => zone === undefined || zone.trim() === '' || zone.trim() === 'Etc/Unknown' || CLOSED_ZONES.has(zone.trim());

/** The machine's resolved IANA zone, or `undefined` when the runtime cannot say. */
export const machineZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};
