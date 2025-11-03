const MS_PER_DAY = 86_400_000;
const DAYS_PER_WEEK = 7;
const MS_PER_WEEK = MS_PER_DAY * DAYS_PER_WEEK;

export interface WeeklyDemandPoint {
  weekStart: string;
  quantity: number;
  promo?: boolean;
}

export interface HoltWintersOptions {
  alpha?: number;
  beta?: number;
  gamma?: number;
  seasonalPeriod?: number;
  horizon?: number;
  minHistoryLength?: number;
}

export interface WeeklyForecastPoint {
  weekStart: string;
  actual: number | null;
  forecast: number;
  phase: 'history' | 'forecast';
  promo?: boolean;
}

export interface HoltWintersWeeklyResult {
  timeline: WeeklyForecastPoint[];
  seasonalFactors: number[];
  seasonalPeriod: number;
  smoothing: {
    alpha: number;
    beta: number;
    gamma: number;
  };
  level: number;
  trend: number;
  mape: number | null;
}

const clampProbability = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const clampSeasonalPeriod = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 4;
  }
  const normalized = Math.round(value);
  return Math.min(Math.max(normalized, 2), 12);
};

const clampDemand = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value;
};

const startOfUtcWeek = (date: Date): Date => {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utcDate.getUTCDay(); // 0 (Sun) .. 6 (Sat)
  const offsetToMonday = (day + 6) % 7;
  utcDate.setUTCDate(utcDate.getUTCDate() - offsetToMonday);
  return utcDate;
};

const formatWeekStart = (date: Date): string => {
  const start = startOfUtcWeek(date);
  const year = start.getUTCFullYear();
  const month = String(start.getUTCMonth() + 1).padStart(2, '0');
  const day = String(start.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseWeekStart = (value: string): Date => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return startOfUtcWeek(new Date());
  }
  const normalized = value.includes('T') ? value : `${value}T00:00:00Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return startOfUtcWeek(new Date());
  }
  return startOfUtcWeek(date);
};

const addWeeks = (date: Date, weeks: number): Date => new Date(date.getTime() + weeks * MS_PER_WEEK);

interface NormalizedPoint {
  weekStart: string;
  quantity: number;
  promo: boolean;
}

const normalizeHistory = (history: WeeklyDemandPoint[]): NormalizedPoint[] => {
  const totals = new Map<string, number>();
  const promoWeeks = new Set<string>();

  history.forEach((point) => {
    if (!point) {
      return;
    }
    const date = parseWeekStart(point.weekStart);
    const key = formatWeekStart(date);
    const quantity = clampDemand(Number(point.quantity ?? 0));
    totals.set(key, (totals.get(key) ?? 0) + quantity);
    if (point.promo) {
      promoWeeks.add(key);
    }
  });

  return Array.from(totals.entries())
    .map(([weekStart, quantity]) => ({
      weekStart,
      quantity,
      promo: promoWeeks.has(weekStart),
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
};

const ensureMinimumHistory = (
  normalized: NormalizedPoint[],
  minLength: number,
): NormalizedPoint[] => {
  if (normalized.length === 0) {
    const now = startOfUtcWeek(new Date());
    const fallbackQuantity = 0;
    const synthetic: NormalizedPoint[] = [];
    for (let index = minLength - 1; index >= 0; index -= 1) {
      const weekStart = formatWeekStart(addWeeks(now, -index));
      synthetic.push({ weekStart, quantity: fallbackQuantity, promo: false });
    }
    return synthetic;
  }

  if (normalized.length >= minLength) {
    return normalized;
  }

  const fallbackQuantity =
    normalized.reduce((sum, point) => sum + point.quantity, 0) / Math.max(normalized.length, 1);
  const extended = [...normalized];
  while (extended.length < minLength) {
    const first = extended[0];
    const firstDate = parseWeekStart(first.weekStart);
    const previous = formatWeekStart(addWeeks(firstDate, -1));
    extended.unshift({
      weekStart: previous,
      quantity: fallbackQuantity,
      promo: false,
    });
  }

  return extended;
};

const initializeSeasonals = (values: number[], period: number): number[] => {
  if (values.length < period) {
    return new Array(period).fill(1);
  }

  const seasonCount = Math.max(1, Math.floor(values.length / period));
  if (seasonCount < 2) {
    return new Array(period).fill(1);
  }

  const seasonAverages: number[] = [];
  for (let season = 0; season < seasonCount; season += 1) {
    let sum = 0;
    let count = 0;
    for (let index = 0; index < period; index += 1) {
      const valueIndex = season * period + index;
      if (valueIndex >= values.length) {
        break;
      }
      sum += values[valueIndex];
      count += 1;
    }
    seasonAverages.push(count > 0 ? sum / count : 0);
  }

  const seasonals = new Array(period).fill(1);

  for (let index = 0; index < period; index += 1) {
    let seasonalSum = 0;
    let seasonalCount = 0;
    for (let season = 0; season < seasonCount; season += 1) {
      const valueIndex = season * period + index;
      if (valueIndex >= values.length) {
        break;
      }
      const average = seasonAverages[season];
      if (average > 0) {
        seasonalSum += values[valueIndex] / average;
        seasonalCount += 1;
      }
    }
    seasonals[index] = seasonalCount > 0 ? seasonalSum / seasonalCount : 1;
  }

  const sum = seasonals.reduce((acc, value) => acc + value, 0);
  if (sum <= 0) {
    return new Array(period).fill(1);
  }

  return seasonals.map((value) => (value * period) / sum);
};

const initializeLevel = (values: number[], period: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const span = Math.min(period, values.length);
  const total = values.slice(0, span).reduce((sum, value) => sum + value, 0);
  return total / span;
};

const initializeTrend = (values: number[], period: number): number => {
  if (values.length < period + 1) {
    const first = values[0] ?? 0;
    const last = values[values.length - 1] ?? 0;
    return (last - first) / Math.max(values.length - 1, 1);
  }

  if (values.length >= period * 2) {
    let total = 0;
    for (let index = 0; index < period; index += 1) {
      const first = values[index];
      const second = values[index + period];
      total += (second - first) / period;
    }
    return total / period;
  }

  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  return (last - first) / Math.max(values.length - 1, 1);
};

export function buildWeeklyForecast(
  rawHistory: WeeklyDemandPoint[],
  options: HoltWintersOptions = {},
): HoltWintersWeeklyResult {
  const seasonalPeriod = clampSeasonalPeriod(options.seasonalPeriod ?? 4);
  const horizon = Math.max(1, Math.round(options.horizon ?? 8));
  const minHistoryLength = Math.max(
    seasonalPeriod * 2,
    Math.round(options.minHistoryLength ?? seasonalPeriod * 3),
  );

  const alpha = clampProbability(options.alpha ?? 0.3);
  const beta = clampProbability(options.beta ?? 0.2);
  const gamma = clampProbability(options.gamma ?? 0.3);

  let normalized = normalizeHistory(rawHistory);
  normalized = ensureMinimumHistory(normalized, minHistoryLength);

  const values = normalized.map((point) => clampDemand(point.quantity));
  const allZero = values.every((value) => value === 0);
  if (allZero) {
    const zeroTimeline: WeeklyForecastPoint[] = [];
    const lastWeekDate = parseWeekStart(normalized[normalized.length - 1].weekStart);

    normalized.forEach((point) => {
      zeroTimeline.push({
        weekStart: point.weekStart,
        actual: point.quantity,
        forecast: 0,
        phase: 'history',
        promo: point.promo,
      });
    });

    for (let step = 1; step <= horizon; step += 1) {
      const futureWeek = formatWeekStart(addWeeks(lastWeekDate, step));
      zeroTimeline.push({
        weekStart: futureWeek,
        actual: null,
        forecast: 0,
        phase: 'forecast',
        promo: false,
      });
    }

    return {
      timeline: zeroTimeline,
      seasonalFactors: new Array(seasonalPeriod).fill(1),
      seasonalPeriod,
      smoothing: { alpha, beta, gamma },
      level: 0,
      trend: 0,
      mape: null,
    };
  }

  let level = initializeLevel(values, seasonalPeriod);
  let trend = initializeTrend(values, seasonalPeriod);
  const seasonals = initializeSeasonals(values, seasonalPeriod);

  const fitted: number[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const actual = values[index];
    const seasonIndex = index % seasonalPeriod;
    const previousSeasonal = seasonals[seasonIndex] ?? 1;
    const baseline = level + trend;
    const forecast = clampDemand(baseline * previousSeasonal);
    fitted.push(forecast);

    const previousLevel = level;
    const previousTrend = trend;

    const deseasonalized = previousSeasonal > 0 ? actual / previousSeasonal : actual;
    level = alpha * deseasonalized + (1 - alpha) * (previousLevel + previousTrend);
    trend = beta * (level - previousLevel) + (1 - beta) * previousTrend;

    let updatedSeason = previousSeasonal;
    if (level > 0) {
      const rawSeason = gamma * (actual / level) + (1 - gamma) * previousSeasonal;
      if (Number.isFinite(rawSeason) && rawSeason > 0) {
        updatedSeason = rawSeason;
      }
    }
    seasonals[seasonIndex] = Math.max(0.01, Math.min(updatedSeason, 10));
  }

  const timeline: WeeklyForecastPoint[] = [];
  normalized.forEach((point, index) => {
    timeline.push({
      weekStart: point.weekStart,
      actual: point.quantity,
      forecast: Math.round(fitted[index]),
      phase: 'history',
      promo: point.promo,
    });
  });

  const lastWeekDate = parseWeekStart(normalized[normalized.length - 1].weekStart);
  for (let step = 1; step <= horizon; step += 1) {
    const seasonIndex = (values.length + step - 1) % seasonalPeriod;
    const seasonalFactor = seasonals[seasonIndex] ?? 1;
    const forecastValue = clampDemand((level + trend * step) * seasonalFactor);
    timeline.push({
      weekStart: formatWeekStart(addWeeks(lastWeekDate, step)),
      actual: null,
      forecast: Math.round(forecastValue),
      phase: 'forecast',
      promo: false,
    });
  }

  const absolutePercentageErrors = normalized
    .map((point, index) => {
      const actual = point.quantity;
      const predicted = fitted[index];
      if (actual <= 0) {
        return null;
      }
      const error = Math.abs(actual - predicted) / actual;
      return Number.isFinite(error) ? error : null;
    })
    .filter((value): value is number => value !== null);

  const mape =
    absolutePercentageErrors.length > 0
      ? (absolutePercentageErrors.reduce((sum, value) => sum + value, 0) / absolutePercentageErrors.length) * 100
      : null;

  const sumSeasonals = seasonals.reduce((sum, value) => sum + value, 0);
  const normalizedSeasonals =
    sumSeasonals > 0 ? seasonals.map((value) => (value * seasonalPeriod) / sumSeasonals) : [...seasonals];

  return {
    timeline,
    seasonalFactors: normalizedSeasonals,
    seasonalPeriod,
    smoothing: { alpha, beta, gamma },
    level,
    trend,
    mape: mape !== null ? Math.round(mape * 10) / 10 : null,
  };
}

