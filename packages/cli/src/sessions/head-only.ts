// A transcript file whose every record is a head record its harness's own format defines (the session header, the model in force) and that has no turn in
// it: a session started and quit. `sessions verify` counts such a file as empty, not unreadable. A torn line, a non-object line, or a record of any other
// type makes the file something else, so a format that moved still shows as unreadable.

/** True when the text has at least one line and every line is a JSON object that `accepts`. */
export const holdsOnlyRecords = (text: string, accepts: (record: { type: string; [key: string]: unknown }) => boolean): boolean => {
  const lines = text.split('\n').filter((raw) => raw.trim() !== '');
  if (lines.length === 0) return false;
  return lines.every((raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    return typeof parsed === 'object' && parsed !== null && 'type' in parsed && typeof parsed.type === 'string' && accepts({ ...parsed, type: parsed.type });
  });
};

/** True when the text has at least one line and every line is a JSON object whose `type` is one of `kinds`. */
export const holdsOnlyKinds = (text: string, kinds: ReadonlySet<string>): boolean => holdsOnlyRecords(text, (record) => kinds.has(record.type));
