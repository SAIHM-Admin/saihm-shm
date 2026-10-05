export type FeatureName = "events" | "warmStart" | "replicas" | "capacity";

export const SERVER_FEATURE_NAMES: readonly FeatureName[] = Object.freeze(["events", "warmStart", "replicas", "capacity"] as const);

export const READ_VERSION = 1;

export const MAX_LIST_ENTRIES = 64;

export const MAX_LABEL_LENGTH = 64;

export const MAX_REPORT_PATH_LENGTH = 256;

export const MAX_DURATION_LENGTH = 64;

export const FAST_TIERS: readonly string[] = Object.freeze(["PRO_FAST", "ENTERPRISE_FAST"]);

export const OWN_CELL_EVENT_KINDS: readonly string[] = Object.freeze(["cell-written", "cell-erased"]);

export const WARM_START_TOKEN = "required";

export type FeatureRead<T> =
  | { readonly kind: "available"; readonly value: T }
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "unsupported-version"; readonly reason: string }
  | { readonly kind: "malformed"; readonly field: string; readonly reason: string };

export type UnusableRule = "fast-tier-only" | "needs-own-cell-events" | "needs-token";

export type GatedFeatureRead<T> = FeatureRead<T> | { readonly kind: "unusable"; readonly rule: UnusableRule; readonly reason: string };

export interface EventsFeature {
  readonly v: readonly number[];
  readonly kinds: readonly string[] | null;
  readonly ownCellEvents: boolean;
}

export interface WarmStartFeature {
  readonly v: readonly number[];
  readonly token: typeof WARM_START_TOKEN;
  readonly maxBytes: number;
  readonly maxSnapshots: number;
  readonly retentionS: number;
}

export type ErasureFence = "synchronous" | "bounded";

export interface ReplicasFeature {
  readonly v: readonly number[];
  readonly maxStalenessMs: number;
  readonly erasureFence: ErasureFence;
}

export type AttainmentEntry =
  | {
    readonly operation: string;
    readonly percentile: number;
    readonly thresholdMs: number;
    readonly samples: number;
    readonly observedMs: number;
    readonly met: boolean;
  }
  | {
    readonly operation: string;
    readonly percentile: number;
    readonly thresholdMs: number;
    readonly samples: number;
    readonly observedMs: null;
    readonly met: null;
  };

export interface AttainmentReport {
  readonly v: number;
  readonly window: string;
  readonly windowMs: number;
  readonly asOf: string;
  readonly asOfMs: number;
  readonly operations: readonly AttainmentEntry[];
}

export type CapacityFeature =
  | {
    readonly v: readonly number[];
    readonly reserved: true;
    readonly unit: string;
    readonly rate: number;
    readonly burst: number;
    readonly objectiveApplies: boolean;
    readonly attainment: FeatureRead<AttainmentReport>;
  }
  | {
    readonly v: readonly number[];
    readonly reserved: false;
    readonly unit: string;
    readonly rate: null;
    readonly burst: null;
    readonly objectiveApplies: false;
    readonly attainment: FeatureRead<AttainmentReport>;
  };

export interface ServerFeatures {
  readonly events: FeatureRead<EventsFeature>;
  readonly warmStart: GatedFeatureRead<WarmStartFeature>;
  readonly replicas: GatedFeatureRead<ReplicasFeature>;
  readonly capacity: GatedFeatureRead<CapacityFeature>;
}

export interface LatencyObjectiveEntry {
  readonly operation: string;
  readonly percentile: number;
  readonly thresholdMs: number;
}

export interface LatencyObjective {
  readonly v: readonly number[];
  readonly window: string;
  readonly windowMs: number;
  readonly measured: "service";
  readonly objectives: readonly LatencyObjectiveEntry[];
  readonly tiers: readonly string[];
  readonly reportPath: string | null;
}

const STATUS_ROOT = "status result";
const INFO_ROOT = "info document";
const NOT_A_LABEL = `is not a name of 1 to ${MAX_LABEL_LENGTH} printable ASCII characters`;

class FieldError {
  readonly field: string;
  readonly reason: string;
  constructor(field: string, reason: string) {
    this.field = field;
    this.reason = reason;
  }
}

function fail(field: string, what: string): never {
  throw new FieldError(field, `${field} ${what}`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);

const isPositiveWhole = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const isNonNegativeWhole = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const isNonNegativeFinite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const isPercentile = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0 && x <= 100;

const PRINTABLE_TRIMMED = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/;

export function isFeatureLabel(s: unknown): s is string {
  return typeof s === "string" && s.length <= MAX_LABEL_LENGTH && PRINTABLE_TRIMMED.test(s);
}

const available = <T>(value: T): FeatureRead<T> => Object.freeze({ kind: "available" as const, value });
const absent = (reason: string): FeatureRead<never> => Object.freeze({ kind: "absent" as const, reason });
const unsupported = (reason: string): FeatureRead<never> => Object.freeze({ kind: "unsupported-version" as const, reason });
const malformed = (field: string, reason: string): FeatureRead<never> => Object.freeze({ kind: "malformed" as const, field, reason });
const unusable = (rule: UnusableRule, reason: string): GatedFeatureRead<never> => Object.freeze({ kind: "unusable" as const, rule, reason });

function guard<R>(path: string, read: () => R): R | FeatureRead<never> {
  try {
    return read();
  } catch (e) {
    if (e instanceof FieldError) return malformed(e.field, e.reason);
    return malformed(path, `${path} could not be read`);
  }
}

function required(o: Record<string, unknown>, path: string, key: string): unknown {
  const v = own(o, key);
  if (v === undefined) fail(`${path}.${key}`, "is missing");
  return v;
}

function versions(o: Record<string, unknown>, path: string): readonly number[] {
  const field = `${path}.v`;
  const v = required(o, path, "v");
  if (!Array.isArray(v)) fail(field, "is not a list of versions");
  if (v.length > MAX_LIST_ENTRIES) fail(field, `holds more than ${MAX_LIST_ENTRIES} entries`);
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) {
    const x: unknown = v[i];
    if (!isPositiveWhole(x)) fail(`${field}[${i}]`, "is not a positive whole number");
    out.push(x);
  }
  return Object.freeze(out);
}

function wholeNumber(o: Record<string, unknown>, path: string, key: string): number {
  const v = required(o, path, key);
  if (!isNonNegativeWhole(v)) fail(`${path}.${key}`, "is not a non-negative whole number");
  return v;
}

function nullableWholeNumber(o: Record<string, unknown>, path: string, key: string): number | null {
  const v = required(o, path, key);
  if (v === null) return null;
  if (!isNonNegativeWhole(v)) fail(`${path}.${key}`, "is not null or a non-negative whole number");
  return v;
}

function positiveWholeNumber(o: Record<string, unknown>, path: string, key: string): number {
  const v = required(o, path, key);
  if (!isPositiveWhole(v)) fail(`${path}.${key}`, "is not a positive whole number");
  return v;
}

function nonNegativeNumber(o: Record<string, unknown>, path: string, key: string): number {
  const v = required(o, path, key);
  if (!isNonNegativeFinite(v)) fail(`${path}.${key}`, "is not a finite, non-negative number");
  return v;
}

function percentileOf(o: Record<string, unknown>, path: string, key: string): number {
  const v = required(o, path, key);
  if (!isPercentile(v)) fail(`${path}.${key}`, "is not a finite number above 0 and at most 100");
  return v;
}

function flag(o: Record<string, unknown>, path: string, key: string): boolean {
  const v = required(o, path, key);
  if (typeof v !== "boolean") fail(`${path}.${key}`, "is not true or false");
  return v;
}

function nullableFlag(o: Record<string, unknown>, path: string, key: string): boolean | null {
  const v = required(o, path, key);
  if (v === null) return null;
  if (typeof v !== "boolean") fail(`${path}.${key}`, "is not true, false or null");
  return v;
}

function label(o: Record<string, unknown>, path: string, key: string): string {
  const v = required(o, path, key);
  if (!isFeatureLabel(v)) fail(`${path}.${key}`, NOT_A_LABEL);
  return v;
}

function labels(o: Record<string, unknown>, path: string, key: string, isRequired: boolean): readonly string[] | null {
  const field = `${path}.${key}`;
  const v = own(o, key);
  if (v === undefined || (v === null && !isRequired)) {
    if (isRequired) fail(field, "is missing");
    return null;
  }
  if (!Array.isArray(v)) fail(field, "is not a list");
  if (v.length > MAX_LIST_ENTRIES) fail(field, `holds more than ${MAX_LIST_ENTRIES} entries`);
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const x: unknown = v[i];
    if (!isFeatureLabel(x)) fail(`${field}[${i}]`, NOT_A_LABEL);
    out.push(x);
  }
  return Object.freeze(out);
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW = /^P(?:([1-9][0-9]*)D|T([1-9][0-9]*)H)$/;

function windowOf(o: Record<string, unknown>, path: string, key: string): { readonly text: string; readonly ms: number } {
  const field = `${path}.${key}`;
  const v = required(o, path, key);
  if (typeof v !== "string") fail(field, "is not a string");
  const m = v.length <= MAX_DURATION_LENGTH ? WINDOW.exec(v) : null;
  if (m === null) fail(field, "is not a whole number of days (PnD) or of hours (PTnH), above zero");
  const ms = m[1] !== undefined ? Number(m[1]) * DAY_MS : Number(m[2]) * HOUR_MS;
  if (!Number.isSafeInteger(ms)) fail(field, "is longer than an exact whole number of milliseconds can state");
  return { text: v, ms };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function utcTime(o: Record<string, unknown>, path: string, key: string): { readonly text: string; readonly ms: number } {
  const field = `${path}.${key}`;
  const v = required(o, path, key);
  if (typeof v !== "string" || !ISO_UTC.test(v)) fail(field, "is not an ISO-8601 UTC time");
  const t = Date.parse(v);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 19) !== v.slice(0, 19)) fail(field, "is not a real calendar time");
  return { text: v, ms: t };
}

const SAME_ORIGIN_PATH = /^\/(?!\/)(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*$/;

function optionalOriginPath(o: Record<string, unknown>, path: string, key: string): string | null {
  const v = own(o, key);
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > MAX_REPORT_PATH_LENGTH || !SAME_ORIGIN_PATH.test(v)) {
    fail(`${path}.${key}`, `is not a path on the service's own origin of at most ${MAX_REPORT_PATH_LENGTH} characters`);
  }
  return v;
}

type FeatureReader<T> = (o: Record<string, unknown>, path: string, v: readonly number[]) => T;

const UNUSABLE_BECAUSE: Readonly<Record<UnusableRule, string>> = Object.freeze({
  "fast-tier-only":
    `is offered only on the Fast tiers (${FAST_TIERS.join(", ")}), and the status result names none of them as this identity's tier`,
  "needs-own-cell-events":
    `is usable only together with own-cell events, and features.events does not offer both ${OWN_CELL_EVENT_KINDS.join(" and ")}`,
  "needs-token": `is usable only when its token member is "${WARM_START_TOKEN}" (a client that names its payload files per call), and it is not`,
});

function readFeature<T>(features: Record<string, unknown>, name: FeatureName, read: FeatureReader<T>): FeatureRead<T>;
function readFeature<T>(
  features: Record<string, unknown>, name: FeatureName, read: FeatureReader<T>, forbiddenBy: UnusableRule | null,
  objectRule?: (o: Record<string, unknown>) => UnusableRule | null,
): GatedFeatureRead<T>;
function readFeature<T>(
  features: Record<string, unknown>, name: FeatureName, read: FeatureReader<T>, forbiddenBy: UnusableRule | null = null,
  objectRule?: (o: Record<string, unknown>) => UnusableRule | null,
): GatedFeatureRead<T> {
  const path = `features.${name}`;
  return guard(path, (): GatedFeatureRead<T> => {
    const raw = own(features, name);
    if (raw === undefined) return absent(`${path} is missing: this identity cannot use the feature`);
    if (raw === null) return absent(`${path} is null: this identity cannot use the feature`);
    if (forbiddenBy !== null) return unusable(forbiddenBy, `${path} ${UNUSABLE_BECAUSE[forbiddenBy]}: this identity cannot use it`);
    if (!isObject(raw)) fail(path, "is not an object");
    const v = versions(raw, path);
    if (!v.includes(READ_VERSION)) return unsupported(`${path}.v does not list version ${READ_VERSION}, the only version this release reads`);
    const ruled = objectRule?.(raw) ?? null;
    if (ruled !== null) return unusable(ruled, `${path} ${UNUSABLE_BECAUSE[ruled]}: this identity cannot use it`);
    return available(read(raw, path, v));
  });
}

function namesFastTier(statusResult: Record<string, unknown>): boolean {
  try {
    const tier = own(statusResult, "tier");
    return typeof tier === "string" && FAST_TIERS.includes(tier);
  } catch {
    return false;
  }
}

const readEvents: FeatureReader<EventsFeature> = (o, path, v) => {
  const kinds = labels(o, path, "kinds", false);
  return Object.freeze({ v, kinds, ownCellEvents: kinds !== null && OWN_CELL_EVENT_KINDS.every((k) => kinds.includes(k)) });
};

const warmStartTokenRule = (o: Record<string, unknown>): UnusableRule | null => (own(o, "token") === WARM_START_TOKEN ? null : "needs-token");

const readWarmStart: FeatureReader<WarmStartFeature> = (o, path, v) =>
  Object.freeze({
    v,
    token: WARM_START_TOKEN,
    maxBytes: wholeNumber(o, path, "maxBytes"),
    maxSnapshots: wholeNumber(o, path, "maxSnapshots"),
    retentionS: wholeNumber(o, path, "retentionS"),
  });

function fenceMode(o: Record<string, unknown>, path: string, key: string): ErasureFence {
  const v = required(o, path, key);
  if (v !== "synchronous" && v !== "bounded") fail(`${path}.${key}`, 'is not "synchronous" or "bounded", the two fence modes this release reads');
  return v;
}

const readReplicas: FeatureReader<ReplicasFeature> = (o, path, v) =>
  Object.freeze({ v, maxStalenessMs: wholeNumber(o, path, "maxStalenessMs"), erasureFence: fenceMode(o, path, "erasureFence") });

const readCapacity: FeatureReader<CapacityFeature> = (o, path, v) => {
  const reserved = flag(o, path, "reserved");
  const unit = label(o, path, "unit");
  if (reserved) {
    const value: CapacityFeature = {
      v,
      reserved: true,
      unit,
      rate: nonNegativeNumber(o, path, "rate"),
      burst: wholeNumber(o, path, "burst"),
      objectiveApplies: flag(o, path, "objectiveApplies"),
      attainment: readAttainment(o, path),
    };
    return Object.freeze(value);
  }
  for (const key of ["rate", "burst"]) {
    if (required(o, path, key) !== null) fail(`${path}.${key}`, "is not null, as it must be when reserved is false");
  }
  if (required(o, path, "objectiveApplies") !== false) fail(`${path}.objectiveApplies`, "is not false, as it must be when reserved is false");
  const value: CapacityFeature = { v, reserved: false, unit, rate: null, burst: null, objectiveApplies: false, attainment: readAttainment(o, path) };
  return Object.freeze(value);
};

function readAttainment(capacity: Record<string, unknown>, capacityPath: string): FeatureRead<AttainmentReport> {
  const path = `${capacityPath}.attainment`;
  return guard(path, (): FeatureRead<AttainmentReport> => {
    const raw = own(capacity, "attainment");
    if (raw === undefined) return absent(`${path} is missing: the service stated no attainment for this identity`);
    if (raw === null) return absent(`${path} is null: the service stated no attainment for this identity`);
    if (!isObject(raw)) fail(path, "is not an object");
    const v = required(raw, path, "v");
    if (!isPositiveWhole(v)) fail(`${path}.v`, "is not a positive whole number");
    if (v !== READ_VERSION) return unsupported(`${path}.v is not ${READ_VERSION}, the only report version this release reads`);
    const window = windowOf(raw, path, "window");
    const asOf = utcTime(raw, path, "asOf");
    const operations = attainmentEntries(raw, path);
    return available(Object.freeze({ v, window: window.text, windowMs: window.ms, asOf: asOf.text, asOfMs: asOf.ms, operations }));
  });
}

function attainmentEntries(o: Record<string, unknown>, path: string): readonly AttainmentEntry[] {
  const field = `${path}.operations`;
  const list = required(o, path, "operations");
  if (!Array.isArray(list)) fail(field, "is not a list");
  if (list.length > MAX_LIST_ENTRIES) fail(field, `holds more than ${MAX_LIST_ENTRIES} entries`);
  const out: AttainmentEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const at = `${field}[${i}]`;
    const e: unknown = list[i];
    if (!isObject(e)) fail(at, "is not an object");
    const operation = label(e, at, "operation");
    const percentile = percentileOf(e, at, "percentile");
    const thresholdMs = positiveWholeNumber(e, at, "thresholdMs");
    const samples = wholeNumber(e, at, "samples");
    const observedMs = nullableWholeNumber(e, at, "observedMs");
    if (observedMs !== null && samples === 0) fail(`${at}.observedMs`, "is stated, but samples is 0: an operation with no traffic has no figure");
    const met = nullableFlag(e, at, "met");
    let entry: AttainmentEntry;
    if (observedMs === null || met === null) {
      if (observedMs !== met) fail(`${at}.met`, "is stated where observedMs is null, or null where observedMs is stated");
      entry = { operation, percentile, thresholdMs, samples, observedMs: null, met: null };
    } else {
      if (met !== observedMs <= thresholdMs) fail(`${at}.met`, "contradicts the entry's own figures: met is observedMs <= thresholdMs");
      entry = { operation, percentile, thresholdMs, samples, observedMs, met };
    }
    const key = `${operation}\n${percentile}`;
    if (seen.has(key)) fail(at, "repeats an operation and percentile stated earlier in the list");
    seen.add(key);
    out.push(Object.freeze(entry));
  }
  return Object.freeze(out);
}

export function parseServerFeatures(statusResult: unknown): ServerFeatures {
  const all = (r: FeatureRead<never>): ServerFeatures => Object.freeze({ events: r, warmStart: r, replicas: r, capacity: r });
  let features: unknown;
  try {
    if (!isObject(statusResult)) return all(malformed(STATUS_ROOT, `the ${STATUS_ROOT} is not an object`));
  } catch {
    return all(malformed(STATUS_ROOT, `the ${STATUS_ROOT} could not be read`));
  }
  try {
    features = own(statusResult, "features");
    if (features !== undefined && features !== null && !isObject(features)) return all(malformed("features", "features is not an object"));
  } catch {
    return all(malformed("features", "features could not be read"));
  }
  if (features === undefined) {
    return all(absent(`the ${STATUS_ROOT} carries no features object: a server that predates feature discovery offers none of the four`));
  }
  if (features === null) return all(absent("features is null: this identity can use none of the four"));
  const f = features as Record<string, unknown>;
  const fastTier = namesFastTier(statusResult);
  const events = readFeature(f, "events", readEvents);
  const ownCellEvents = events.kind === "available" && events.value.ownCellEvents;
  return Object.freeze({
    events,
    warmStart: readFeature(f, "warmStart", readWarmStart, ownCellEvents ? null : "needs-own-cell-events", warmStartTokenRule),
    replicas: readFeature(f, "replicas", readReplicas, fastTier ? null : "fast-tier-only"),
    capacity: readFeature(f, "capacity", readCapacity, fastTier ? null : "fast-tier-only"),
  });
}

function objectiveEntries(o: Record<string, unknown>, path: string): readonly LatencyObjectiveEntry[] {
  const field = `${path}.objectives`;
  const list = required(o, path, "objectives");
  if (!Array.isArray(list)) fail(field, "is not a list");
  if (list.length === 0) fail(field, "is empty: it states no objective");
  if (list.length > MAX_LIST_ENTRIES) fail(field, `holds more than ${MAX_LIST_ENTRIES} entries`);
  const out: LatencyObjectiveEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const at = `${field}[${i}]`;
    const e: unknown = list[i];
    if (!isObject(e)) fail(at, "is not an object");
    const operation = label(e, at, "operation");
    const percentile = percentileOf(e, at, "percentile");
    const thresholdMs = positiveWholeNumber(e, at, "thresholdMs");
    const key = `${operation}\n${percentile}`;
    if (seen.has(key)) fail(at, "repeats an operation and percentile stated earlier in the list");
    seen.add(key);
    out.push(Object.freeze({ operation, percentile, thresholdMs }));
  }
  return Object.freeze(out);
}

export function parseLatencyObjective(infoDocument: unknown): FeatureRead<LatencyObjective> {
  const path = "latencyObjective";
  let raw: unknown;
  try {
    if (!isObject(infoDocument)) return malformed(INFO_ROOT, `the ${INFO_ROOT} is not an object`);
    raw = own(infoDocument, path);
  } catch {
    return malformed(INFO_ROOT, `the ${INFO_ROOT} could not be read`);
  }
  if (raw === undefined) return absent(`the ${INFO_ROOT} carries no ${path}: no objective exists, and none may be stated`);
  if (raw === null) return absent(`${path} is null: no objective exists, and none may be stated`);
  return guard(path, (): FeatureRead<LatencyObjective> => {
    if (!isObject(raw)) fail(path, "is not an object");
    const v = versions(raw, path);
    if (!v.includes(READ_VERSION)) return unsupported(`${path}.v does not list version ${READ_VERSION}, the only version this release reads`);
    const window = windowOf(raw, path, "window");
    const measured = required(raw, path, "measured");
    if (typeof measured !== "string") fail(`${path}.measured`, "is not a string");
    if (measured !== "service") fail(`${path}.measured`, "names a point other than the service, the only one this release can compare against");
    const objectives = objectiveEntries(raw, path);
    const tiers = labels(raw, path, "tiers", true) ?? fail(`${path}.tiers`, "is missing");
    const reportPath = optionalOriginPath(raw, path, "reportPath");
    return available(
      Object.freeze({ v, window: window.text, windowMs: window.ms, measured: "service" as const, objectives, tiers, reportPath }),
    );
  });
}
