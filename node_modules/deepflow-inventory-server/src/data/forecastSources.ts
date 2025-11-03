import { __findProductByLegacyId, __findProductBySku, type ProductResponse } from '../routes/products.js';
import { getPolicyDraft, type PolicyDraftRecord } from '../stores/policiesStore.js';
import { getDailyMovementHistory } from '../stores/movementAnalyticsStore.js';

export interface DemandHistoryPoint {
  date: string; // ISO yyyy-mm-01
  quantity: number;
  promo?: boolean;
}

export interface UpcomingPromotion {
  month: string; // ISO yyyy-mm-01 for the first day of month
  note: string;
}

export interface ForecastProduct {
  id: number;
  sku: string;
  name: string;
  category: string;
  safetyStock: number;
  leadTimeDays: number;
  serviceLevelPercent: number;
  serviceLevelZ: number;
  configuredReorderPoint: number;
  onHand: number;
  reserved: number;
  avgDaily: number;
  smoothingAlpha: number | null;
  corrRho: number | null;
  history: DemandHistoryPoint[];
  futurePromotions?: UpcomingPromotion[];
}

const DEFAULT_SERVICE_LEVEL_PERCENT = 95;
const DEFAULT_LEAD_TIME_DAYS = 14;
const DEFAULT_HISTORY_MONTH_LIMIT = 24;
const MIN_HISTORY_MONTHS = 6;
const DEFAULT_SMOOTHING_ALPHA = 0.4;
const DEFAULT_CORRELATION_RHO = 0.25;
const SERVICE_LEVEL_Z_TABLE: Array<{ percent: number; z: number }> = [
  { percent: 90, z: 1.2816 },
  { percent: 95, z: 1.6449 },
  { percent: 98, z: 2.0537 },
  { percent: 99, z: 2.3263 },
];

const RISK_SHORTAGE = '결품위험';
const RISK_OVERSTOCK = '과잉';

const toUtcDate = (value: string): Date => {
  const normalized = value.includes('T') ? value : `${value}T00:00:00Z`;
  return new Date(normalized);
};

const formatMonthStart = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
};

const resolveServiceLevelZ = (percent: number): number => {
  if (!Number.isFinite(percent)) {
    return 0;
  }

  let nearest = SERVICE_LEVEL_Z_TABLE[0];
  let minDiff = Math.abs(percent - nearest.percent);

  for (const entry of SERVICE_LEVEL_Z_TABLE) {
    const diff = Math.abs(percent - entry.percent);
    if (diff < minDiff) {
      nearest = entry;
      minDiff = diff;
    }
  }

  return nearest.z;
};

const resolveServiceLevelPercent = (
  product: ProductResponse,
  policy: PolicyDraftRecord | null,
): number => {
  const candidate = policy?.serviceLevelPercent;
  if (Number.isFinite(candidate ?? NaN) && (candidate ?? 0) > 0) {
    return Math.min(Math.max(candidate as number, 50), 99.9);
  }

  switch (product.risk) {
    case RISK_SHORTAGE:
      return 98;
    case RISK_OVERSTOCK:
      return 90;
    default:
      return DEFAULT_SERVICE_LEVEL_PERCENT;
  }
};

const normalizeAlpha = (value: number | null | undefined): number | null => {
  if (!Number.isFinite(value ?? NaN)) {
    return null;
  }
  return Math.max(0, Math.min((value as number), 1));
};

const normalizeCorrelation = (value: number | null | undefined): number | null => {
  if (!Number.isFinite(value ?? NaN)) {
    return null;
  }
  return Math.max(0, Math.min((value as number), 0.5));
};

const resolveLeadTimeDays = (policy: PolicyDraftRecord | null): number => {
  const candidate = policy?.leadTimeDays;
  if (Number.isFinite(candidate ?? NaN) && (candidate ?? 0) > 0) {
    return Math.max(1, Math.round(candidate as number));
  }
  return DEFAULT_LEAD_TIME_DAYS;
};

const resolveDemandStdDev = (product: ProductResponse, policy: PolicyDraftRecord | null): number => {
  const candidate = policy?.demandStdDev;
  if (Number.isFinite(candidate ?? NaN) && (candidate ?? 0) > 0) {
    return Math.max(candidate as number, 0);
  }
  if (Number.isFinite(product.dailyStd) && product.dailyStd > 0) {
    return Math.max(product.dailyStd, 0);
  }
  return 0;
};

const resolveCorrelation = (policy: PolicyDraftRecord | null): number => {
  const normalized = normalizeCorrelation(policy?.corrRho);
  if (normalized !== null) {
    return normalized;
  }
  return DEFAULT_CORRELATION_RHO;
};

const computeSafetyStock = (
  product: ProductResponse,
  policy: PolicyDraftRecord | null,
  serviceLevelPercentOverride?: number,
): number => {
  const sigma = resolveDemandStdDev(product, policy);
  if (sigma <= 0) {
    return 0;
  }

  const leadTimeDays = resolveLeadTimeDays(policy);
  if (!Number.isFinite(leadTimeDays) || leadTimeDays <= 0) {
    return 0;
  }

  const serviceLevelPercent =
    Number.isFinite(serviceLevelPercentOverride ?? Number.NaN) && (serviceLevelPercentOverride ?? 0) > 0
      ? (serviceLevelPercentOverride as number)
      : resolveServiceLevelPercent(product, policy);
  const z = resolveServiceLevelZ(serviceLevelPercent);
  if (z <= 0) {
    return 0;
  }

  const rho = resolveCorrelation(policy);
  const leadTimeFactor = Math.sqrt(leadTimeDays * (1 + rho));

  return Math.max(0, Math.round(z * sigma * leadTimeFactor));
};

const buildMonthlyHistory = (sku: string, monthsLimit = DEFAULT_HISTORY_MONTH_LIMIT): DemandHistoryPoint[] => {
  const dailyHistory = getDailyMovementHistory({ sku });
  if (dailyHistory.length === 0) {
    return [];
  }

  const totals = new Map<string, number>();
  dailyHistory.forEach((point) => {
    const date = toUtcDate(point.date);
    if (Number.isNaN(date.getTime())) {
      return;
    }
    const monthKey = formatMonthStart(date);
    const outbound = Number.isFinite(point.outbound) ? Math.max(Math.round(point.outbound), 0) : 0;
    totals.set(monthKey, (totals.get(monthKey) ?? 0) + outbound);
  });

  if (totals.size === 0) {
    return [];
  }

  const monthKeys = Array.from(totals.keys()).sort((a, b) => a.localeCompare(b));
  const first = toUtcDate(monthKeys[0]);
  const last = toUtcDate(monthKeys[monthKeys.length - 1]);

  const points: DemandHistoryPoint[] = [];
  let cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
  const end = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1));

  while (cursor.getTime() <= end.getTime()) {
    const monthKey = formatMonthStart(cursor);
    points.push({
      date: monthKey,
      quantity: totals.get(monthKey) ?? 0,
      promo: false,
    });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }

  return monthsLimit > 0 ? points.slice(-monthsLimit) : points;
};

const deriveFallbackMonthlyQuantity = (
  product: ProductResponse,
  policy: PolicyDraftRecord | null,
): number => {
  const policyForecastRaw = policy?.forecastDemand;
  const policyForecast =
    Number.isFinite(policyForecastRaw ?? NaN) && (policyForecastRaw ?? 0) > 0
      ? Math.max(policyForecastRaw as number, 0)
      : 0;
  if (policyForecast > 0) {
    return Math.max(Math.round(policyForecast * 30), 0);
  }

  const dailyAvg = Number.isFinite(product.dailyAvg) ? Math.max(product.dailyAvg, 0) : 0;
  if (dailyAvg > 0) {
    return Math.max(Math.round(dailyAvg * 30), 0);
  }

  const totalOutbound = Number.isFinite(product.totalOutbound) ? Math.max(product.totalOutbound, 0) : 0;
  if (totalOutbound > 0) {
    return Math.max(Math.round(totalOutbound / Math.max(MIN_HISTORY_MONTHS, 1)), 0);
  }

  const availableStock = Math.max(product.onHand - product.reserved, 0);
  if (availableStock > 0) {
    const leadTime = resolveLeadTimeDays(policy) || DEFAULT_LEAD_TIME_DAYS;
    const estimatedMonthly = (availableStock / Math.max(leadTime, 1)) * 30;
    if (estimatedMonthly > 0) {
      return Math.max(Math.round(estimatedMonthly), 1);
    }
  }

  return 30;
};

const generateSyntheticHistory = (months: number, monthlyQuantity: number): DemandHistoryPoint[] => {
  if (months <= 0 || monthlyQuantity <= 0) {
    return [];
  }

  const base = new Date();
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - months + 1, 1));
  const quantity = Math.max(Math.round(monthlyQuantity), 0);
  const synthetic: DemandHistoryPoint[] = [];

  for (let index = 0; index < months; index += 1) {
    const monthDate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1));
    synthetic.push({
      date: formatMonthStart(monthDate),
      quantity,
      promo: false,
    });
  }

  return synthetic;
};

const ensureHistoryCoverage = (
  product: ProductResponse,
  policy: PolicyDraftRecord | null,
  history: DemandHistoryPoint[],
): DemandHistoryPoint[] => {
  const normalized = [...history]
    .filter((point) => point && typeof point.date === 'string')
    .map((point) => ({
      ...point,
      date: formatMonthStart(toUtcDate(point.date)),
      quantity: Number.isFinite(point.quantity) ? Math.max(Math.round(point.quantity), 0) : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (normalized.length >= MIN_HISTORY_MONTHS) {
    return normalized;
  }

  const fallbackMonthlyQuantity = deriveFallbackMonthlyQuantity(product, policy);
  if (fallbackMonthlyQuantity <= 0) {
    return normalized;
  }

  if (normalized.length === 0) {
    return generateSyntheticHistory(MIN_HISTORY_MONTHS, fallbackMonthlyQuantity);
  }

  while (normalized.length < MIN_HISTORY_MONTHS) {
    const first = normalized[0];
    const firstDate = toUtcDate(first.date);
    const previousMonth = new Date(Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth() - 1, 1));
    normalized.unshift({
      date: formatMonthStart(previousMonth),
      quantity: Math.max(Math.round(fallbackMonthlyQuantity), 0),
      promo: false,
    });
  }

  return normalized;
};

const toForecastProduct = (product: ProductResponse): ForecastProduct => {
  const policy = getPolicyDraft(product.sku);
  const history = ensureHistoryCoverage(product, policy, buildMonthlyHistory(product.sku));
  const serviceLevelPercent = resolveServiceLevelPercent(product, policy);
  const serviceLevelZ = resolveServiceLevelZ(serviceLevelPercent);
  const safetyStock = computeSafetyStock(product, policy, serviceLevelPercent);
  const leadTimeDays = resolveLeadTimeDays(policy);
  const avgDaily = Number.isFinite(product.dailyAvg) ? Math.max(Math.round(product.dailyAvg), 0) : 0;
  const smoothingAlpha = normalizeAlpha(policy?.smoothingAlpha);
  const corrRho = normalizeCorrelation(policy?.corrRho);

  return {
    id: product.legacyProductId,
    sku: product.sku,
    name: product.name,
    category: product.category,
    safetyStock,
    leadTimeDays,
    serviceLevelPercent,
    serviceLevelZ,
    configuredReorderPoint: 0,
    onHand: product.onHand,
    reserved: product.reserved,
    avgDaily,
    history,
    smoothingAlpha,
    corrRho,
    futurePromotions: [],
  };
};

export function findForecastProduct(productId: number): ForecastProduct | undefined {
  if (!Number.isFinite(productId)) {
    return undefined;
  }
  const record = __findProductByLegacyId(Math.trunc(productId));
  if (!record) {
    return undefined;
  }
  return toForecastProduct(record);
}

export function findForecastProductBySku(sku: string): ForecastProduct | undefined {
  if (!sku) {
    return undefined;
  }
  const record = __findProductBySku(sku);
  if (!record) {
    return undefined;
  }
  return toForecastProduct(record);
}
