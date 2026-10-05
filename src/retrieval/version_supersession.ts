export interface VersionedCell {
  readonly cellId: string;
  readonly label: string;
  readonly epoch: number;
}

export interface Currency {
  readonly stem: string;
  readonly version: number;
  readonly dateOrd: number;
}

const NAME_BOUNDARY_RE = /\n|\s[—–]\s?|\s\(|\.\s/;

const VERSION_RE = /[\s\-_]v(\d{1,4})\b/gi;

const DATE_RE = /[\s\-_]?(\d{4})-(\d{2})-(\d{2})(?:[t~][\d:.~]*z?)?([a-z]?)\b/gi;

function nameOf(label: string): string {
  const m = NAME_BOUNDARY_RE.exec(label);
  const name = m ? label.slice(0, m.index) : label;
  return name.slice(0, 100);
}

function normalizeStem(name: string): string {
  return name
    .replace(VERSION_RE, " ")
    .replace(DATE_RE, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isSubstantialStem(stem: string): boolean {
  let segs = 0;
  for (const s of stem.split("-")) if (s.length >= 2) segs++;
  return segs >= 2;
}

export function parseCurrency(label: string): Currency {
  const name = nameOf(label);
  const stem = normalizeStem(name);

  let version = 0;
  for (const m of name.matchAll(VERSION_RE)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > version) version = v;
  }

  let dateOrd = 0;
  for (const m of name.matchAll(DATE_RE)) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) continue;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    let ord = y * 10000 + mo * 100 + d;
    const letter = m[4];
    if (letter && letter.length === 1) {
      const bump = (letter.toLowerCase().charCodeAt(0) - 96) / 100;
      if (bump > 0 && bump < 1) ord += bump;
    }
    if (ord > dateOrd) dateOrd = ord;
  }

  return { stem, version, dateOrd };
}

function strictlyDominated(a: Currency, b: Currency): boolean {
  if (a.version !== b.version) return a.version < b.version;
  return a.dateOrd < b.dateOrd;
}

interface Member {
  readonly cell: VersionedCell;
  readonly cur: Currency;
}

function moreCurrent(m: Member, best: Member): boolean {
  if (m.cur.version !== best.cur.version) return m.cur.version > best.cur.version;
  if (m.cur.dateOrd !== best.cur.dateOrd) return m.cur.dateOrd > best.cur.dateOrd;
  if (m.cell.epoch !== best.cell.epoch) return m.cell.epoch > best.cell.epoch;
  return m.cell.cellId < best.cell.cellId;
}

export function computeVersionSupersededBy(cells: readonly VersionedCell[]): Map<string, string> {
  const groups = new Map<string, Member[]>();
  for (const cell of cells) {
    const cur = parseCurrency(cell.label);
    if (!isSubstantialStem(cur.stem)) continue;
    const g = groups.get(cur.stem);
    if (g) g.push({ cell, cur });
    else groups.set(cur.stem, [{ cell, cur }]);
  }

  const out = new Map<string, string>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    let current = members[0]!;
    for (const m of members) if (moreCurrent(m, current)) current = m;
    for (const m of members) {
      if (m.cell.cellId === current.cell.cellId) continue;
      if (strictlyDominated(m.cur, current.cur)) out.set(m.cell.cellId, current.cell.cellId);
    }
  }
  return out;
}
