import type { WeeklyDemandPoint } from './holtWintersWeekly.js';

export interface WeeklyDemandWindowOptions {
  minWeeks?: number;
  maxWeeks?: number;
  excludePromoWeeks?: boolean;
}

export interface WeeklyDemandSummary {
  mean: number;
  stdDev: number;
  sampleSize: number;
  totalQuantity: number;
}

export interface ReorderPointInputs {
  meanWeeklyDemand: number;
  stdWeeklyDemand: number;
  leadTimeWeeks: number;
  serviceLevelZ: number;
}

const clampNonNegative = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value;
};

const DEFAULT_MIN_WEEKS = 4;
const DEFAULT_MAX_WEEKS = 8;

const clampWindow = (value: number | undefined, min: number, max: number, fallback: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  return Math.min(Math.max(normalized, min), max);
};

export function summarizeWeeklyDemand(
  history: WeeklyDemandPoint[],
  options: WeeklyDemandWindowOptions = {},
): WeeklyDemandSummary {
  const minWeeks = clampWindow(options.minWeeks, 1, 16, DEFAULT_MIN_WEEKS);
  const maxWeeks = clampWindow(options.maxWeeks, minWeeks, 26, DEFAULT_MAX_WEEKS);
  if (!Array.isArray(history) || history.length === 0) {
    return {
      mean: 0,
      stdDev: 0,
      sampleSize: 0,
      totalQuantity: 0,
    };
  }

  const eligible = history
    .filter((point) => point && Number.isFinite(point.quantity))
    .filter((point) => (options.excludePromoWeeks ? !point.promo : true))
    .map((point) => clampNonNegative(Number(point.quantity ?? 0)));

  if (eligible.length === 0) {
    return {
      mean: 0,
      stdDev: 0,
      sampleSize: 0,
      totalQuantity: 0,
    };
  }

  const windowLength = Math.min(Math.max(minWeeks, eligible.length), maxWeeks);
  const window = eligible.slice(-windowLength);
  const sampleSize = window.length;
  const totalQuantity = window.reduce((sum, value) => sum + value, 0);
  const mean = sampleSize > 0 ? totalQuantity / sampleSize : 0;

  if (sampleSize <= 1) {
    return {
      mean,
      stdDev: 0,
      sampleSize,
      totalQuantity,
    };
  }

  const variance =
    window.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / Math.max(sampleSize - 1, 1);
  const stdDev = variance > 0 ? Math.sqrt(variance) : 0;

  return {
    mean,
    stdDev,
    sampleSize,
    totalQuantity,
  };
}

export function calculateReorderPointWeekly(inputs: ReorderPointInputs): number {
  const mean = clampNonNegative(inputs.meanWeeklyDemand);
  const std = clampNonNegative(inputs.stdWeeklyDemand);
  const leadTimeWeeks = clampNonNegative(inputs.leadTimeWeeks);
  const serviceLevelZ = Number.isFinite(inputs.serviceLevelZ) ? inputs.serviceLevelZ : 0;

  if (leadTimeWeeks <= 0) {
    return 0;
  }

  const baseDemand = mean * leadTimeWeeks;
  const safetyStock = serviceLevelZ > 0 && std > 0 ? serviceLevelZ * std * Math.sqrt(leadTimeWeeks) : 0;
  const reorderPoint = baseDemand + safetyStock;

  if (!Number.isFinite(reorderPoint)) {
    return 0;
  }

  return Math.round(Math.max(0, reorderPoint));
}

export function calculateRecommendedOrderQuantity(reorderPoint: number, availableStock: number): number {
  const rop = clampNonNegative(reorderPoint);
  const available = clampNonNegative(availableStock);
  return Math.max(0, Math.round(rop - available));
}

