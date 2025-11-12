import { getKstDayBoundsUtc } from './kst';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MAX_PURCHASE_ORDER_RANGE_DAYS = 365;
export const MAX_PURCHASE_ORDER_RANGE_MS = MAX_PURCHASE_ORDER_RANGE_DAYS * MS_PER_DAY;

const toIso = (utcMs: number) => new Date(utcMs).toISOString();

export type DateRange = {
  from: string;
  to: string;
};

const toUtcFromKst = (
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
  milliseconds = 0,
) => Date.UTC(year, month, day, hours, minutes, seconds, milliseconds) - KST_OFFSET_MS;

const getKstLocalDate = (referenceUtcMs: number) => {
  const shifted = new Date(referenceUtcMs + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
};

const getTodayRange = () => {
  const { startUtcMs, endUtcMs } = getKstDayBoundsUtc();
  return { from: toIso(startUtcMs), to: toIso(endUtcMs) };
};

const getRecentDaysRange = (days: number) => {
  const { startUtcMs, endUtcMs } = getKstDayBoundsUtc();
  const start = startUtcMs - (days - 1) * MS_PER_DAY;
  return { from: toIso(start), to: toIso(endUtcMs) };
};

const getLastWeekRange = () => {
  const { startUtcMs } = getKstDayBoundsUtc();
  const { weekday } = getKstLocalDate(startUtcMs);
  const distanceToMonday = (weekday + 6) % 7;
  const thisWeekMondayStart = startUtcMs - distanceToMonday * MS_PER_DAY;
  const lastWeekStart = thisWeekMondayStart - 7 * MS_PER_DAY;
  const lastWeekEnd = lastWeekStart + 7 * MS_PER_DAY - 1;
  return { from: toIso(lastWeekStart), to: toIso(lastWeekEnd) };
};

const getMonthRange = (year: number, month: number) => {
  const start = toUtcFromKst(year, month, 1);
  const nextMonthStart = toUtcFromKst(year, month + 1, 1);
  return { from: toIso(start), to: toIso(nextMonthStart - 1) };
};

const getThisMonthRange = () => {
  const { startUtcMs } = getKstDayBoundsUtc();
  const { year, month } = getKstLocalDate(startUtcMs);
  return getMonthRange(year, month);
};

const getLastMonthRange = () => {
  const { startUtcMs } = getKstDayBoundsUtc();
  const { year, month } = getKstLocalDate(startUtcMs);
  const previousMonth = month === 0 ? 11 : month - 1;
  const previousYear = month === 0 ? year - 1 : year;
  return getMonthRange(previousYear, previousMonth);
};

const getRecent12MonthsRange = () => {
  const { startUtcMs, endUtcMs } = getKstDayBoundsUtc();
  const start = startUtcMs - (MAX_PURCHASE_ORDER_RANGE_DAYS - 1) * MS_PER_DAY;
  return { from: toIso(start), to: toIso(endUtcMs) };
};

const parseLocalDateSegment = (value?: string) => {
  if (!value) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const monthIndex = month - 1;
  const candidate = new Date(year, monthIndex, day);
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== monthIndex ||
    candidate.getDate() !== day
  ) {
    return null;
  }
  return { year, monthIndex, day };
};

const buildUtcForSegment = (
  segment: ReturnType<typeof parseLocalDateSegment>,
  isEndOfDay: boolean,
) => {
  if (!segment) {
    return null;
  }
  if (isEndOfDay) {
    return toUtcFromKst(segment.year, segment.monthIndex, segment.day, 23, 59, 59, 999);
  }
  return toUtcFromKst(segment.year, segment.monthIndex, segment.day);
};

export const buildRangeFromDateStrings = (fromDate: string, toDate: string): DateRange | null => {
  const startSegment = parseLocalDateSegment(fromDate);
  const endSegment = parseLocalDateSegment(toDate);
  if (!startSegment || !endSegment) {
    return null;
  }
  const startUtc = buildUtcForSegment(startSegment, false);
  const endUtc = buildUtcForSegment(endSegment, true);
  if (startUtc === null || endUtc === null || endUtc < startUtc) {
    return null;
  }
  return { from: toIso(startUtc), to: toIso(endUtc) };
};

export type KstRangePreset =
  | 'today'
  | 'recent7Days'
  | 'recent30Days'
  | 'lastWeek'
  | 'thisMonth'
  | 'lastMonth'
  | 'recent12Months';

export const KST_RANGE_PRESETS: KstRangePreset[] = [
  'today',
  'recent7Days',
  'recent30Days',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'recent12Months',
];

export const buildRangeForPreset = (preset: KstRangePreset): DateRange => {
  switch (preset) {
    case 'today':
      return getTodayRange();
    case 'recent7Days':
      return getRecentDaysRange(7);
    case 'recent30Days':
      return getRecentDaysRange(30);
    case 'lastWeek':
      return getLastWeekRange();
    case 'thisMonth':
      return getThisMonthRange();
    case 'lastMonth':
      return getLastMonthRange();
    case 'recent12Months':
      return getRecent12MonthsRange();
    default:
      return getTodayRange();
  }
};
