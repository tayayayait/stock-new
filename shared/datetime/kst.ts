const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const KST_OFFSET_HOURS = 9;
const KST_OFFSET_MS = KST_OFFSET_HOURS * MS_PER_HOUR;

const DATETIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export interface KstDayBounds {
  startUtcMs: number;
  endUtcMs: number;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

const coerceUtcMs = (input: number | string | Date): number | null => {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : null;
  }
  if (input instanceof Date) {
    const timestamp = input.getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
  }
  if (typeof input === 'string') {
    const parsed = new Date(input);
    const timestamp = parsed.getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
  }
  return null;
};

const buildShiftedParts = (utcMs: number, offsetMs: number) => {
  const shifted = new Date(utcMs + offsetMs);
  return {
    year: shifted.getUTCFullYear(),
    month: pad2(shifted.getUTCMonth() + 1),
    day: pad2(shifted.getUTCDate()),
    hours: pad2(shifted.getUTCHours()),
    minutes: pad2(shifted.getUTCMinutes()),
    seconds: pad2(shifted.getUTCSeconds()),
  };
};

const formatKstDisplayCore = (utcMs: number, withSeconds = false): string => {
  const parts = buildShiftedParts(utcMs, KST_OFFSET_MS);
  const time = withSeconds ? `${parts.hours}:${parts.minutes}:${parts.seconds}` : `${parts.hours}:${parts.minutes}`;
  return `${parts.year}-${parts.month}-${parts.day} ${time} KST (UTC+9)`;
};

const formatUtcDisplayCore = (utcMs: number, withSeconds = false): string => {
  const parts = buildShiftedParts(utcMs, 0);
  const time = withSeconds ? `${parts.hours}:${parts.minutes}:${parts.seconds}` : `${parts.hours}:${parts.minutes}`;
  return `${parts.year}-${parts.month}-${parts.day} ${time} UTC`;
};

const formatDateTimeLocalCore = (utcMs: number): string => {
  const parts = buildShiftedParts(utcMs, KST_OFFSET_MS);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hours}:${parts.minutes}`;
};

export const ensureDateTimeLocalPrecision = (value: string): string => {
  const match = DATETIME_LOCAL_PATTERN.exec(value.trim());
  if (!match) {
    return value.trim();
  }
  const [, year, month, day, hour, minute] = match;
  return `${year}-${month}-${day}T${hour}:${minute}`;
};

export const parseKstDateTimeLocal = (value: string): number | null => {
  const match = DATETIME_LOCAL_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = match;
  const utcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    second ? Number(second) : 0,
  );
  if (!Number.isFinite(utcMs)) {
    return null;
  }
  return utcMs - KST_OFFSET_MS;
};

export const convertKstDateTimeLocalToIso = (value: string): string | null => {
  const utcMs = parseKstDateTimeLocal(value);
  if (utcMs === null) {
    return null;
  }
  return new Date(utcMs).toISOString();
};

export const formatDateTimeLocalFromUtc = (input: number | string | Date): string => {
  const utcMs = coerceUtcMs(input);
  if (utcMs === null) {
    return '';
  }
  return formatDateTimeLocalCore(utcMs);
};

export const formatKstDateTimeLabelFromUtc = (
  input: number | string | Date,
  options?: { withSeconds?: boolean },
): string | null => {
  const utcMs = coerceUtcMs(input);
  if (utcMs === null) {
    return null;
  }
  return formatKstDisplayCore(utcMs, options?.withSeconds);
};

export const formatUtcDateTimeLabelFromUtc = (
  input: number | string | Date,
  options?: { withSeconds?: boolean },
): string | null => {
  const utcMs = coerceUtcMs(input);
  if (utcMs === null) {
    return null;
  }
  return formatUtcDisplayCore(utcMs, options?.withSeconds);
};

export const formatKstDateTimeLabelFromLocal = (value: string, options?: { withSeconds?: boolean }) => {
  const utcMs = parseKstDateTimeLocal(value);
  if (utcMs === null) {
    return null;
  }
  return formatKstDisplayCore(utcMs, options?.withSeconds);
};

export const formatUtcDateTimeLabelFromLocal = (value: string, options?: { withSeconds?: boolean }) => {
  const utcMs = parseKstDateTimeLocal(value);
  if (utcMs === null) {
    return null;
  }
  return formatUtcDisplayCore(utcMs, options?.withSeconds);
};

export const getKstDayBoundsUtc = (referenceUtcMs = Date.now()): KstDayBounds => {
  const startUtcMs = Math.floor((referenceUtcMs + KST_OFFSET_MS) / MS_PER_DAY) * MS_PER_DAY - KST_OFFSET_MS;
  const endUtcMs = startUtcMs + MS_PER_DAY - 1;
  return { startUtcMs, endUtcMs };
};

export const formatKstBoundsLabel = (bounds: KstDayBounds): string => {
  const start = formatKstDateTimeLabelFromUtc(bounds.startUtcMs);
  const end = formatKstDateTimeLabelFromUtc(bounds.endUtcMs);
  if (!start || !end) {
    return '';
  }
  const startLabel = start.replace(' KST (UTC+9)', '');
  const endLabel = end.replace(' KST (UTC+9)', '');
  return `${startLabel} ~ ${endLabel} KST (UTC+9)`;
};

export const isUtcWithinBounds = (utcMs: number, bounds: KstDayBounds): boolean =>
  utcMs >= bounds.startUtcMs && utcMs <= bounds.endUtcMs;

export const isKstDateTimeLocalWithinBounds = (value: string, bounds: KstDayBounds): boolean => {
  const utcMs = parseKstDateTimeLocal(value);
  if (utcMs === null) {
    return false;
  }
  return isUtcWithinBounds(utcMs, bounds);
};

export const isUtcWithinKstToday = (utcMs: number, referenceUtcMs = Date.now()): boolean => {
  const bounds = getKstDayBoundsUtc(referenceUtcMs);
  return isUtcWithinBounds(utcMs, bounds);
};

export const isKstDateTimeLocalWithinToday = (value: string, referenceUtcMs = Date.now()): boolean => {
  const bounds = getKstDayBoundsUtc(referenceUtcMs);
  return isKstDateTimeLocalWithinBounds(value, bounds);
};

export const describeKstTodayWindow = (): { bounds: KstDayBounds; label: string } => {
  const bounds = getKstDayBoundsUtc();
  const label = formatKstBoundsLabel(bounds);
  return { bounds, label };
};

export type DeviceUiMode = 'dial' | 'spinner';

export const detectTimePickerUiMode = (): DeviceUiMode => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'spinner';
  }
  return window.matchMedia('(pointer: coarse)').matches ? 'dial' : 'spinner';
};
