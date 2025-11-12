import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  createEmptyProduct,
  DEFAULT_UNIT,
  normalizeProduct,
  normalizeSku,
  type InventoryRisk,
  type Product,
  type ProductInventoryEntry,
} from '../../../domains/products';
import {
  fetchForecast,
  fetchWarehouses,
  requestForecastInsight,
  type ApiWarehouse,
  type ForecastInsight,
  type ForecastInsightRequestPayload,
  type ForecastResponse,
} from '../../../services/api';
import { downloadTemplate } from '../../../services/csv';
import * as ProductService from '../../../services/products';
import { type HttpError } from '../../../services/http';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { motion } from 'framer-motion';
import ServiceCoveragePanel from '../../../../components/ServiceCoveragePanel';
import PolicyMetricsChart from './components/PolicyMetricsChart';
import WarehouseManagementPanel from './components/WarehouseManagementPanel';
import PartnerManagementPanel from './components/PartnerManagementPanel';
import CategoryManagementPanel from './components/CategoryManagementPanel';
import ProductCsvUploadDialog from './components/ProductCsvUploadDialog';
import CategoryManageDialog from './components/CategoryManageDialog';
import PolicyOpsDashboard from './components/PolicyOpsDashboard';
import { type ForecastRange } from './components/ForecastChart';
import ForecastChartCard from './components/ForecastChartCard';
import ForecastInsightsSection from './components/ForecastInsightsSection';
import type { ActionPlanItem, ActionPlanRecord } from '../../../services/actionPlans';
import { fetchLatestActionPlan, submitActionPlan, approveActionPlan } from '../../../services/actionPlans';
import { extractFirstDetail, validateProductDraft } from './productValidation';
import ProductForm from './components/ProductForm';
import ProductDetailPanel from './components/ProductDetailPanel';
import InventoryOverviewPage from './components/InventoryOverviewPage';
import { subscribeInventoryRefresh } from '../../utils/inventoryEvents';
import {
  savePolicies,
  fetchPolicies,
  requestForecastRecommendation,
  upsertPolicy,
  type PolicyDraft,
  type ForecastRecommendationResult,
  type ForecastRecommendationPayload,
} from '../../../services/policies';
import { fetchInventoryAnalysis } from '../../../services/inventoryDashboard';
import PurchasePage from './components/PurchasePage';
import SalesPage from './components/SalesPage';
import { DEFAULT_DASHBOARD_TAB, SmartWarehouseOutletContext } from '../../layout/SmartWarehouseLayout';

interface ForecastRow {
  date: string;
  actual: number;
  fc: number;
  promo?: boolean;
}

interface ForecastSeriesPoint {
  date: string;
  isoDate: string;
  actual: number | null;
  fc: number;
  phase: 'history' | 'forecast';
  promo?: boolean;
}

interface ForecastStateEntry {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data?: ForecastResponse;
  error?: string;
}

interface InsightStateEntry {
  status: 'idle' | 'loading' | 'ready' | 'error';
  key?: string;
  data?: ForecastInsight;
  error?: string | null;
  actionPlan?: ActionPlanRecord | null;
  planFetchedAt?: number;
}

interface ForecastPageProps {
  skus: Product[];
  promoExclude: boolean;
  setPromoExclude: (value: boolean) => void;
  forecastCache: Record<string, ForecastResponse>;
  forecastStatusBySku: Record<string, ForecastStateEntry>;
  policyBySku: ReadonlyMap<string, PolicyRow>;
}

export interface PolicyRow extends PolicyDraft {}

const POLICY_STORAGE_KEY = 'stock-console:policy-drafts';

const sanitizePolicyDraftList = (value: unknown): PolicyRow[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const record = entry as Partial<PolicyRow>;
      if (typeof record.sku !== 'string' || !record.sku.trim()) {
        return null;
      }

      const normalizeNumber = (input: unknown): number | null => {
        if (typeof input !== 'number' || !Number.isFinite(input)) {
          return null;
        }
        const rounded = Math.max(0, Math.round(input));
        return Number.isFinite(rounded) ? rounded : null;
      };

      const normalizePercent = (input: unknown): number | null => {
        if (typeof input !== 'number' || !Number.isFinite(input)) {
          return null;
        }
        const clamped = Math.max(50, Math.min(99.9, input));
        return Number.isFinite(clamped) ? clamped : null;
      };

      return {
        sku: normalizeSku(record.sku),
        name:
          typeof record.name === 'string' && record.name.trim().length > 0
            ? record.name.trim()
            : null,
        forecastDemand: normalizeNumber(record.forecastDemand ?? null),
        demandStdDev: normalizeNumber(record.demandStdDev ?? null),
        leadTimeDays: normalizeNumber(record.leadTimeDays ?? null),
        serviceLevelPercent: normalizePercent(record.serviceLevelPercent ?? null),
        smoothingAlpha: FALLBACK_SMOOTHING_ALPHA,
        corrRho: FALLBACK_CORRELATION_RHO,
      } satisfies PolicyRow;
    })
    .filter((entry): entry is PolicyRow => entry !== null);
};

const readPolicyDraftBackup = (): PolicyRow[] => {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(POLICY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    return sanitizePolicyDraftList(JSON.parse(raw));
  } catch {
    return [];
  }
};

const writePolicyDraftBackup = (rows: PolicyRow[]) => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (rows.length === 0) {
      window.localStorage.removeItem(POLICY_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Ignore quota errors or unavailable storage
  }
};

const MANUAL_SKU_STORAGE_KEY = 'stock-console:manual-policy-skus';
const readManualSkuBackup = (): string[] => {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(MANUAL_SKU_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const unique = new Set<string>();
    parsed.forEach((entry) => {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        unique.add(normalizeSku(entry));
      }
    });
    return Array.from(unique.values());
  } catch {
    return [];
  }
};

const writeManualSkuBackup = (skus: string[]) => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const normalized = Array.from(new Set((skus ?? []).map((sku) => normalizeSku(sku))));
    if (normalized.length === 0) {
      window.localStorage.removeItem(MANUAL_SKU_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(MANUAL_SKU_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore quota errors or unavailable storage
  }
};

const normalizePolicyRow = (row: PolicyRow): PolicyRow => ({
  ...row,
  sku: normalizeSku(row.sku),
  name: row.name && row.name.trim().length > 0 ? row.name.trim() : null,
  smoothingAlpha: FALLBACK_SMOOTHING_ALPHA,
  corrRho: FALLBACK_CORRELATION_RHO,
});

interface KpiSummary {
  opening: number;
  avgDOS: number;
  turns: number;
  serviceLevel: number;
}

interface RiskSummaryEntry {
  risk: InventoryRisk;
  count: number;
  ratio: number;
}

type DrawerMode = 'new' | 'edit';

interface ProductDrawerState {
  originalSku?: string;
  mode: DrawerMode;
  row: Product;
}

type CsvStatusMessage = { kind: 'error' | 'success'; message: string };

const INITIAL_FORECAST: ForecastRow[] = [
  { date: '25-07', actual: 2000, fc: 2300 },
  { date: '25-08', actual: 5000, fc: 4800, promo: true },
  { date: '25-09', actual: 3000, fc: 3200 },
  { date: '25-10', actual: 2600, fc: 2800 },
  { date: '25-11', actual: 5200, fc: 5100 },
  { date: '25-12', actual: 4400, fc: 4489 },
];

const SERVICE_LEVEL_PRESETS = [85, 90, 93, 95, 97.5, 99] as const;
const BULK_APPLY_DEVIATION_THRESHOLD = 0.2; // ±20%

type BulkApplyModeOption = 'fill' | 'overwrite';
type BulkApplyTargetContext = 'search' | 'all';

interface BulkApplyOptions {
  mode: BulkApplyModeOption;
  includeLeadTime: boolean;
  includeServiceLevel: boolean;
  includeManual: boolean;
}

interface BulkApplyProgress {
  total: number;
  completed: number;
}

interface BulkApplyResultSummary {
  total: number;
  applied: number;
  skipped: Array<{ sku: string; reason: string }>;
  failed: Array<{ sku: string; reason: string }>;
}

const DEFAULT_BULK_APPLY_OPTIONS: BulkApplyOptions = {
  mode: 'fill',
  includeLeadTime: false,
  includeServiceLevel: false,
  includeManual: false,
};

interface SanitizedRecommendationValues {
  forecastDemand: number | null;
  demandStdDev: number | null;
  leadTimeDays: number | null;
  serviceLevelPercent: number | null;
}

const toNonNegativeInteger = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.max(0, Math.round(value));
  return Number.isFinite(normalized) ? normalized : null;
};

const clampServiceLevelPercentValue = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.max(50, Math.min(99.9, value));
  return clamped;
};

const sanitizeRecommendationValues = (result: ForecastRecommendationResult): SanitizedRecommendationValues => ({
  forecastDemand: toNonNegativeInteger(result.forecastDemand),
  demandStdDev: toNonNegativeInteger(result.demandStdDev),
  leadTimeDays: toNonNegativeInteger(result.leadTimeDays),
  serviceLevelPercent: clampServiceLevelPercentValue(result.serviceLevelPercent),
});

const applyBulkRecommendationToRow = (
  row: PolicyRow,
  values: SanitizedRecommendationValues,
  options: BulkApplyOptions,
): { nextRow: PolicyRow | null; changed: boolean; reason?: string } => {
  const nextRow: PolicyRow = { ...row };
  const outcomes: Array<{ applied: boolean; reason?: string }> = [];

  const attemptField = (
    field: keyof PolicyRow,
    label: string,
    nextValue: number | null,
    include: boolean,
  ) => {
    if (!include) {
      return;
    }
    if (nextValue === null) {
      outcomes.push({ applied: false, reason: `${label} 추천값 없음` });
      return;
    }
    const currentValue = (nextRow[field] as number | null) ?? null;
    if (options.mode === 'fill' && currentValue !== null) {
      outcomes.push({ applied: false, reason: `${label} 기존 값을 유지했습니다.` });
      return;
    }
    if (options.mode === 'overwrite' && currentValue !== null) {
      const baseline = Math.max(Math.abs(currentValue), 1);
      const deviation = Math.abs(nextValue - currentValue) / baseline;
      if (deviation > BULK_APPLY_DEVIATION_THRESHOLD) {
        outcomes.push({
          applied: false,
          reason: `${label} 변동폭 ${Math.round(deviation * 100)}% > 임계치 ±${Math.round(BULK_APPLY_DEVIATION_THRESHOLD * 100)}%`,
        });
        return;
      }
    }
    if (currentValue === nextValue) {
      outcomes.push({ applied: false, reason: `${label} 변화 없음` });
      return;
    }
    (nextRow as PolicyRow)[field] = nextValue as never;
    outcomes.push({ applied: true });
  };

  attemptField('forecastDemand', '예측 수요량', values.forecastDemand, true);
  attemptField('demandStdDev', '수요 표준편차', values.demandStdDev, true);
  attemptField('leadTimeDays', '리드타임', values.leadTimeDays, options.includeLeadTime);
  attemptField(
    'serviceLevelPercent',
    '서비스 수준',
    values.serviceLevelPercent,
    options.includeServiceLevel,
  );

  const changed = outcomes.some((entry) => entry.applied);
  if (!changed) {
    const reason = outcomes.find((entry) => entry.reason)?.reason ?? '적용 가능한 필드가 없습니다.';
    return { nextRow: null, changed: false, reason };
  }
  return { nextRow, changed: true };
};

const FALLBACK_LEAD_TIME_DAYS = 14;
const FALLBACK_SERVICE_LEVEL_PERCENT = 95;
const FALLBACK_SMOOTHING_ALPHA = 0.4;
const FALLBACK_CORRELATION_RHO = 0.25;
const EWMA_ANALYSIS_DAYS = 90;

const INITIAL_POLICIES: PolicyRow[] = [
  {
    sku: 'D1E2F3G',
    name: '버터 크루아상',
    forecastDemand: 320,
    demandStdDev: 48,
    leadTimeDays: 10,
    serviceLevelPercent: 95,
    smoothingAlpha: FALLBACK_SMOOTHING_ALPHA,
    corrRho: FALLBACK_CORRELATION_RHO,
  },
  {
    sku: 'H4I5J6K',
    name: '시그니처 머핀 믹스',
    forecastDemand: 275,
    demandStdDev: 62,
    leadTimeDays: 21,
    serviceLevelPercent: 97,
    smoothingAlpha: FALLBACK_SMOOTHING_ALPHA,
    corrRho: FALLBACK_CORRELATION_RHO,
  },
  {
    sku: 'L7M8N9O',
    name: '스위트 브리오슈',
    forecastDemand: 190,
    demandStdDev: 28,
    leadTimeDays: 7,
    serviceLevelPercent: 93,
    smoothingAlpha: FALLBACK_SMOOTHING_ALPHA,
    corrRho: FALLBACK_CORRELATION_RHO,
  },
];

const MONTHS = [
  '23-12',
  '24-01',
  '24-02',
  '24-03',
  '24-04',
  '24-05',
  '24-06',
  '24-07',
  '24-08',
  '24-09',
  '24-10',
  '24-11',
  '24-12',
];

const FORECAST_START_IDX = 7;
const erf = (x: number): number => {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const t = 1 / (1 + 0.5 * abs);
  const tau = t * Math.exp(
    -abs * abs -
      1.26551223 +
      t *
        (1.00002368 +
          t *
            (0.37409196 +
              t *
                (0.09678418 +
                  t *
                    (-0.18628806 +
                      t *
                        (0.27886807 +
                          t *
                            (-1.13520398 +
                              t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
  );
  return sign * (1 - tau);
};

const standardNormalCdf = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

const inverseStandardNormalCdf = (p: number): number => {
  if (p <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  if (p >= 1) {
    return Number.POSITIVE_INFINITY;
  }

  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ] as const;
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ] as const;
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ] as const;
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ] as const;

  const plow = 0.02425;
  const phigh = 1 - plow;

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }

  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
};

const serviceLevelPercentageToZ = (percent: number): number => {
  if (!Number.isFinite(percent)) {
    return Number.NaN;
  }
  const probability = Math.min(Math.max(percent / 100, 1e-4), 0.9999);
  return inverseStandardNormalCdf(probability);
};

const zToServiceLevelPercentage = (z: number): number => {
  if (!Number.isFinite(z)) {
    return 0;
  }
  return standardNormalCdf(z) * 100;
};

type ForecastMetrics = ForecastResponse['metrics'];
type ForecastExplanation = ForecastResponse['explanation'];

const createProjectedDate = (daysAhead: number): string | null => {
  if (!Number.isFinite(daysAhead)) {
    return null;
  }

  const base = new Date();
  base.setHours(0, 0, 0, 0);
  base.setDate(base.getDate() + Math.max(0, Math.round(daysAhead)));
  return base.toISOString().split('T')[0] ?? null;
};

const formatForecastValue = (value: number | null | undefined): string => {
  if (!Number.isFinite(value as number)) {
    return '—';
  }
  const rounded = Math.max(Math.round(value as number), 0);
  return rounded.toLocaleString();
};

const buildFallbackMetrics = (product: Product, series: ForecastSeriesPoint[]): ForecastMetrics => {
  const safeSeries = Array.isArray(series) && series.length > 0 ? series : buildFallbackSeries(product, 0, false);

  const history = safeSeries.filter((point) => point.phase === 'history');
  const outboundHistory = history.reduce((sum, point) => sum + Math.max(point.actual ?? 0, 0), 0);
  const promoOutbound = safeSeries
    .filter((point) => point.promo)
    .reduce((sum, point) => {
      const value = point.actual ?? point.fc ?? 0;
      return sum + Math.max(value, 0);
    }, 0);
  const projectedForecast = safeSeries
    .filter((point) => point.phase === 'forecast')
    .reduce((sum, point) => sum + Math.max(point.fc ?? 0, 0), 0);

  const outboundTotal = Math.max(outboundHistory + Math.round(projectedForecast * 0.25), 0);
  const outboundReasons: Record<string, number> = {};
  if (promoOutbound > 0) {
    outboundReasons['프로모션'] = promoOutbound;
  }
  outboundReasons['일반 수요'] = Math.max(outboundTotal - (outboundReasons['프로모션'] ?? 0), 0);

  const avgDailyDemand = Math.max(Math.round(product.dailyAvg), 0);
  const currentTotalStock = Math.max(product.onHand, 0);
  const reorderPoint = Math.max(Math.round(avgDailyDemand * 20), 0);
  const available = availableStock(product);
  const recommendedOrderQty = Math.max(reorderPoint - available, 0);
  const coverageDays = avgDailyDemand > 0 ? available / avgDailyDemand : null;
  const weeklyOutlook = {
    week1: Math.max(Math.round(avgDailyDemand * 7), 0),
    week2: Math.max(Math.round(avgDailyDemand * 7), 0),
    week4: Math.max(Math.round(avgDailyDemand * 7), 0),
    week8: Math.max(Math.round(avgDailyDemand * 7), 0),
  };

  return {
    windowStart: history[0]?.date ?? safeSeries[0]?.date ?? '',
    windowEnd: safeSeries[safeSeries.length - 1]?.date ?? history[history.length - 1]?.date ?? '',
    outboundTotal,
    outboundReasons,
    avgDailyDemand,
    currentTotalStock,
    reorderPoint,
    recommendedOrderQty,
    projectedStockoutDate: coverageDays !== null ? createProjectedDate(coverageDays) : null,
    weeklyOutlook,
  };
};

const buildFallbackExplanation = (product: Product, metrics: ForecastMetrics): ForecastExplanation => {
  const reasonHighlights = Object.entries(metrics.outboundReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, value]) => `${label} 약 ${Math.round(value).toLocaleString()}개`);

  const available = availableStock(product);

  return {
    summary: `${product.name} (${product.sku})는 최근 기간 동안 총 ${metrics.outboundTotal.toLocaleString()}개의 출고가 발생했으며 일 평균 수요는 ${metrics.avgDailyDemand.toLocaleString()}개 수준입니다.`,
    drivers: reasonHighlights,
    details: `가용재고 ${available.toLocaleString()}개, 권장 발주량 ${metrics.recommendedOrderQty.toLocaleString()}개, 재고 소진 예상 ${metrics.projectedStockoutDate ?? '정보 없음'}.`,
    model: {
      name: '휴리스틱 기반 시뮬레이션',
      seasonalPeriod: 3,
      trainingWindow: `${metrics.windowStart || 'N/A'} ~ ${metrics.windowEnd || 'N/A'}`,
      generatedAt: new Date().toISOString(),
      mape: null,
    },
  };
};

const buildActionPlans = (product: Product, metrics: ForecastMetrics): ActionPlanItem[] => {
  const items: ActionPlanItem[] = [];
  const available = availableStock(product);
  const orderQty = Math.max(Math.round(metrics.recommendedOrderQty), 0);
  const reorderGap = Math.max(metrics.reorderPoint - available, 0);

  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  const actionWhen = nextWeek.toISOString().slice(0, 10);

  items.push({
    id: 'llm-local-reorder',
    who: '영업기획팀',
    what:
      reorderGap > 0
        ? `${orderQty.toLocaleString()}EA 발주 확정`
        : '권장 발주량을 유지하고 재고를 모니터링',
    when: actionWhen,
    rationale:
      reorderGap > 0
        ? '가용재고가 재주문점 이하로 내려가 추가 보충이 필요합니다.'
        : '현재 재고가 목표 범위를 유지하고 있어 추가 발주가 필요하지 않습니다.',
    confidence: reorderGap > 0 ? 0.74 : 0.58,
    kpi: {
      name: '서비스 레벨',
      target: '≥95%',
      window: '향후 4주',
    },
  });

  items.push({
    id: 'llm-local-supply',
    who: '공급망팀',
    what: metrics.projectedStockoutDate
      ? `재고 소진 예상일(${metrics.projectedStockoutDate}) 이전 재배치 플랜 수립`
      : '입고 일정·리드타임 검증 및 공급 제약 점검',
    when: actionWhen,
    rationale:
      metrics.projectedStockoutDate !== null
        ? '수요 대비 재고 커버리지가 짧아 대체 공급원을 확보해야 합니다.'
        : '리드타임과 공급 편차를 점검해 예측 정확도를 유지합니다.',
    confidence: metrics.projectedStockoutDate ? 0.71 : 0.6,
    kpi: {
      name: '재고일수(DOS)',
      target: metrics.projectedStockoutDate ? '≥21일' : '20~30일',
      window: '향후 8주',
    },
  });

  return items;
};

const formatMonthLabel = (iso: string): string => {
  if (!iso) {
    return iso;
  }
  if (/^\d{2}-\d{2}$/.test(iso)) {
    return iso;
  }
  const parsed = new Date(iso.includes('T') ? iso : `${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  const year = String(parsed.getUTCFullYear()).slice(-2);
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

const toIsoFromShortLabel = (label: string): string => {
  const match = /^(\d{2})-(\d{2})$/.exec(label);
  if (!match) {
    return label.includes('-') ? (label.length === 7 ? `${label}-01` : label) : label;
  }
  const year = Number.parseInt(match[1], 10);
  const month = match[2];
  const fullYear = year >= 70 ? 1900 + year : 2000 + year;
  return `${fullYear}-${month}-01`;
};

const filterSeriesByMonths = (series: ForecastSeriesPoint[], months: number): ForecastSeriesPoint[] => {
  if (!months || months <= 0 || series.length === 0) {
    return series;
  }

  const now = new Date();
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  cutoff.setUTCMonth(cutoff.getUTCMonth() - (months - 1));
  cutoff.setUTCHours(0, 0, 0, 0);

  return series.filter((point) => {
    const source = point.isoDate ?? point.date;
    const parsed = parseForecastDate(source);
    if (!parsed) {
      return true;
    }
    parsed.setUTCHours(0, 0, 0, 0);
    return parsed.getTime() >= cutoff.getTime();
  });
};

const adjustForecastRange = (
  range: ForecastRange | null,
  data: Array<{ date: string; phase?: 'history' | 'forecast' }>,
): ForecastRange | null => {
  if (!range || data.length === 0) {
    return null;
  }
  const labels = new Set(data.map((point) => point.date));
  let start = labels.has(range.start) ? range.start : null;
  if (!start) {
    start = data.find((point) => point.phase === 'forecast')?.date ?? null;
  }
  let end = labels.has(range.end) ? range.end : null;
  if (!end) {
    end = data[data.length - 1]?.date ?? null;
  }
  if (!start || !end) {
    return null;
  }
  return { start, end };
};

const parseIsoToUtcEpoch = (value: string | undefined | null): number | null => {
  if (!value) {
    return null;
  }
  if (/\d{4}-\d{2}-\d{2}T/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = Date.parse(`${value}T00:00:00+09:00`);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const buildFallbackSeries = (row: Product, idx: number, promoExclude: boolean): ForecastSeriesPoint[] => {
  return MONTHS.map((month, monthIndex) => {
    const base = Math.max(50, Math.round(row.dailyAvg * 18 + (idx + 1) * 25));
    const seasonalMultiplier = monthIndex % 6 === 2 ? 1.6 : monthIndex % 6 === 5 ? 1.4 : 1;
    const seasonal = Math.round(seasonalMultiplier * base);
    const actual = monthIndex < FORECAST_START_IDX
      ? Math.max(10, seasonal + (monthIndex % 2 === 0 ? -120 : 140))
      : null;
    const isPromoMonth = monthIndex === FORECAST_START_IDX + 1;
    const adjustedForecast = promoExclude && isPromoMonth ? 0.92 : 1;
    const fc = Math.round(seasonal * adjustedForecast);

    return {
      date: month,
      isoDate: toIsoFromShortLabel(month),
      actual,
      fc,
      phase: monthIndex < FORECAST_START_IDX ? 'history' : 'forecast',
      promo: isPromoMonth,
    };
  });
};

const STANDARD_COVERAGE_DAYS = 30;
const SAFETY_COVERAGE_DAYS = 12;

const availableStock = (row: Product): number => Math.max(row.onHand - row.reserved, 0);

const pickPositiveNumber = (...candidates: Array<number | null | undefined>): number => {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return 0;
};

const formatIsoDateUtc = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const computeFallbackForecastSnapshot = (product: Product, policy?: PolicyRow | null) => {
  const normalizedLeadTime = Math.max(
    Math.round(pickPositiveNumber(policy?.leadTimeDays, FALLBACK_LEAD_TIME_DAYS)),
    1,
  );

  let avgDaily = pickPositiveNumber(policy?.forecastDemand, product.dailyAvg, product.avgOutbound7d);
  if (avgDaily <= 0) {
    const available = availableStock(product);
    if (available > 0) {
      avgDaily = available / normalizedLeadTime;
    }
  }
  const normalizedAvgDaily = Math.max(Math.round(avgDaily), 0);

  const sigmaCandidate = pickPositiveNumber(policy?.demandStdDev, product.dailyStd);
  const normalizedSigma = sigmaCandidate > 0 ? sigmaCandidate : 0;

  const correlationCandidate = policy?.corrRho;
  const normalizedCorrelation =
    typeof correlationCandidate === 'number' && Number.isFinite(correlationCandidate) && correlationCandidate >= 0
      ? Math.max(0, Math.min(correlationCandidate, 0.5))
      : FALLBACK_CORRELATION_RHO;

  const serviceLevelPercent = pickPositiveNumber(
    policy?.serviceLevelPercent,
    FALLBACK_SERVICE_LEVEL_PERCENT,
  );
  const zScore = serviceLevelPercentageToZ(serviceLevelPercent);

  const safetyStock =
    normalizedSigma > 0 && zScore > 0
      ? Math.max(Math.round(zScore * normalizedSigma * Math.sqrt(normalizedLeadTime * (1 + normalizedCorrelation))), 0)
      : 0;
  const reorderPoint = Math.max(normalizedAvgDaily * normalizedLeadTime + safetyStock, 0);

  const weeklyOutlook = {
    week1: Math.max(Math.round(normalizedAvgDaily * 7), 0),
    week2: Math.max(Math.round(normalizedAvgDaily * 14), 0),
    week4: Math.max(Math.round(normalizedAvgDaily * 28), 0),
    week8: Math.max(Math.round(normalizedAvgDaily * 56), 0),
  };

  return {
    reorderPoint: Math.max(Math.round(reorderPoint), 0),
    safetyStock,
    weeklyOutlook,
  };
};

const resolveExpiryDays = (row: Product): number | null => {
  const value = row.expiryDays;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0) {
    return 0;
  }
  return Math.floor(value);
};

const hasExpiryWithin = (row: Product, threshold: number): boolean => {
  const expiry = resolveExpiryDays(row);
  return expiry !== null && expiry <= threshold;
};

const compareExpiryAsc = (a: Product, b: Product): number => {
  const expiryA = resolveExpiryDays(a);
  const expiryB = resolveExpiryDays(b);
  if (expiryA === null && expiryB === null) {
    return 0;
  }
  if (expiryA === null) {
    return 1;
  }
  if (expiryB === null) {
    return -1;
  }
  return expiryA - expiryB;
};

const formatExpiryBadge = (value: number | null): string => {
  if (value === null) {
    return '만료 정보 없음';
  }
  return `D-${value}`;
};
const safetyStock = (row: Product): number => Math.round(row.dailyAvg * SAFETY_COVERAGE_DAYS);

const isHttpError = (error: unknown): error is HttpError =>
  Boolean(error && typeof error === 'object' && 'payload' in (error as { payload?: unknown }));

const toPositiveInteger = (value: number | null | undefined): number => {
  if (!Number.isFinite(value as number)) {
    return 0;
  }
  return Math.max(Math.round(value as number), 0);
};

const resolveTotalInbound = (row: Product): number => toPositiveInteger(row.totalInbound ?? 0);
const resolveTotalOutbound = (row: Product): number => toPositiveInteger(row.totalOutbound ?? 0);
const resolveAvgOutbound7d = (row: Product): number => toPositiveInteger(row.avgOutbound7d ?? 0);

const calculateEtaDays = (row: Product): number | null => {
  const recentAverage = resolveAvgOutbound7d(row);
  if (recentAverage <= 0) {
    return null;
  }
  const currentStock = toPositiveInteger(row.onHand);
  return Math.max(Math.round(currentStock / recentAverage), 0);
};

const calculateExcessRate = (row: Product, safetyOverride?: number): number | null => {
  const safety = toPositiveInteger(safetyOverride ?? safetyStock(row));
  if (safety <= 0) {
    return null;
  }
  const currentStock = toPositiveInteger(row.onHand);
  const ratio = ((currentStock - safety) / safety) * 100;
  if (!Number.isFinite(ratio)) {
    return null;
  }
  return Math.round(ratio);
};

const calculateServiceLevelPercent = (rows: Product[]): number => {
  const total = Math.max(rows.length, 1);
  const riskCount = rows.filter((row) => row.risk === '결품위험').length;
  const base = 100 - (riskCount / total) * 12;
  return Math.max(82, Math.min(99, Math.round(base)));
};

const projectedStock = (row: Product, daysAhead = 7): number => {
  const projected = availableStock(row) - row.dailyAvg * daysAhead;
  return Math.max(Math.round(projected), 0);
};

const monthlyDemand = (row: Product): number => Math.max(Math.round(row.dailyAvg * 30), 0);

const recommendedAction = (
  row: Product,
): { label: string; tone: string; description: string } => {
  const coverage = calculateEtaDays(row) ?? 0;
  const projected = projectedStock(row);
  const safety = safetyStock(row);

  if (coverage <= Math.max(Math.round(SAFETY_COVERAGE_DAYS / 2), 1)) {
    return {
      label: '긴급 발주',
      tone: 'bg-red-50 text-red-700 border-red-200',
      description: '오늘 발주로 결품 방지',
    };
  }

  if (coverage < SAFETY_COVERAGE_DAYS || projected < safety) {
    return {
      label: '보충 계획',
      tone: 'bg-amber-50 text-amber-700 border-amber-200',
      description: '이번 주 입고 일정 조정',
    };
  }

  if (coverage > Math.round(STANDARD_COVERAGE_DAYS * 1.6)) {
    return {
      label: '재고 소진',
      tone: 'bg-sky-50 text-sky-700 border-sky-200',
      description: '판촉/이동으로 재고 줄이기',
    };
  }

  return {
    label: '모니터링',
    tone: 'bg-slate-100 text-slate-600 border-slate-200',
    description: '일상 점검 유지',
  };
};

type ForecastPeriodLabel =
  | '\uC77C\uC8FC \uD6C4'
  | '\uC774\uC8FC \uD6C4'
  | '\uC77C\uB2EC \uD6C4'
  | '\uC0BC\uB2EC \uD6C4'
  | '\uC721\uB2EC \uD6C4';

type MonthKey = number;

const FORECAST_PERIOD_OPTIONS: Record<ForecastPeriodLabel, number> = {
  '\uC77C\uC8FC \uD6C4': 1,
  '\uC774\uC8FC \uD6C4': 2,
  '\uC77C\uB2EC \uD6C4': 4,
  '\uC0BC\uB2EC \uD6C4': 12,
  '\uC721\uB2EC \uD6C4': 24,
};

type ChartGranularity = 'month' | 'week';
type ChartWindowMonths = 24 | 12 | 6 | 3;

const CHART_WINDOW_OPTIONS: ReadonlyArray<{ label: string; months: ChartWindowMonths }> = [
  { months: 24, label: '이전 24개월' },
  { months: 12, label: '이전 12개월' },
  { months: 6, label: '이전 6개월' },
  { months: 3, label: '이전 3개월' },
];

const WEEK_WINDOW_OPTIONS: ReadonlyArray<{ label: string; months: ChartWindowMonths }> = [
  { months: 12, label: '최근 52주' },
  { months: 6, label: '최근 26주' },
  { months: 3, label: '최근 13주' },
];

const MONTHLY_SHIPMENT_KEY = '\uCD9C\uACE0\uB7C9';
const AVAILABLE_STOCK_KEY = '\uAC00\uC6A9\uC7AC\uACE0';
const SAFETY_STOCK_KEY = '안전재고';
const OVERSTOCK_RATE_KEY = '\uCD08\uACFC\uC7AC\uACE0\uC728';

const parseForecastDate = (value: string): Date | null => {
  if (!value) {
    return null;
  }
  const normalized = value.includes('T') ? value : `${value}T00:00:00Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
};

const toMonthStartKey = (date: Date): MonthKey =>
  Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);

const formatMonthLabelKo = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}\uB144 ${month}\uC6D4`;
};

interface InventoryScope {
  warehouseCode: string | null;
  locationCode: string | null;
}

interface InventorySummary {
  onHand: number;
  reserved: number;
  available: number;
  entries: ProductInventoryEntry[];
}

const summarizeInventoryForScope = (row: Product, scope: InventoryScope): InventorySummary => {
  const baseEntries = Array.isArray(row.inventory) ? row.inventory : [];

  if (!scope.warehouseCode && !scope.locationCode) {
    return {
      onHand: row.onHand,
      reserved: row.reserved,
      available: availableStock(row),
      entries: baseEntries.map((entry) => ({ ...entry })),
    };
  }

  const filtered = baseEntries.filter((entry) => {
    if (scope.warehouseCode && entry.warehouseCode !== scope.warehouseCode) {
      return false;
    }
    if (scope.locationCode && entry.locationCode !== scope.locationCode) {
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    return { onHand: 0, reserved: 0, available: 0, entries: [] };
  }

  const onHand = filtered.reduce((sum, entry) => sum + Math.max(entry.onHand, 0), 0);
  const reserved = filtered.reduce((sum, entry) => sum + Math.max(entry.reserved, 0), 0);

  return {
    onHand,
    reserved,
    available: Math.max(onHand - reserved, 0),
    entries: filtered.map((entry) => ({ ...entry })),
  };
};

const matchesInventoryScope = (row: Product, scope: InventoryScope): boolean => {
  if (!scope.warehouseCode && !scope.locationCode) {
    return true;
  }

  return summarizeInventoryForScope(row, scope).entries.length > 0;
};

const RISK_STOCKOUT: InventoryRisk = '결품위형';
const RISK_NORMAL: InventoryRisk = '정상';
const RISK_OVERSTOCK: InventoryRisk = '과잉';

const RISK_ORDER: InventoryRisk[] = [RISK_STOCKOUT, RISK_NORMAL, RISK_OVERSTOCK];

const riskPillPalette: Record<InventoryRisk, { active: string; outline: string }> = {
  [RISK_STOCKOUT]: {
    active: 'bg-red-50 text-red-700 border-red-200',
    outline: 'border-red-200 text-red-600 hover:bg-red-50/40',
  },
  [RISK_NORMAL]: {
    active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    outline: 'border-emerald-200 text-emerald-600 hover:bg-emerald-50/40',
  },
  [RISK_OVERSTOCK]: {
    active: 'bg-amber-50 text-amber-700 border-amber-200',
    outline: 'border-amber-200 text-amber-600 hover:bg-amber-50/40',
  },
};

interface ProductsPageProps {
  skus: Product[];
  query: string;
  onQueryChange: (value: string) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onEdit: (row: Product) => void;
  onDelete: (row: Product) => void;
  onNew: () => void;
  onCsvUpload: () => void;
  onCsvDownload: () => void;
  csvDownloading: boolean;
  csvStatus: CsvStatusMessage | null;
}

type ProductSortKey = 'name' | 'sku' | 'recent';
type ProductSortDirection = 'asc' | 'desc';

const SORT_OPTION_LABELS: Record<`${ProductSortKey}:${ProductSortDirection}`, string> = {
  'recent:desc': '최근 추가 순',
  'recent:asc': '오래된 순',
  'name:asc': '이름 오름차순',
  'name:desc': '이름 내림차순',
  'sku:asc': 'SKU 오름차순',
  'sku:desc': 'SKU 내림차순',
};

const ProductsPage: React.FC<ProductsPageProps> = ({
  skus,
  query,
  onQueryChange,
  loading,
  error,
  onRetry,
  onEdit,
  onDelete,
  onNew,
  onCsvUpload,
  onCsvDownload,
  csvDownloading,
  csvStatus,
}) => {
  const safeSkus = Array.isArray(skus) ? skus : [];
  const [sortKey, setSortKey] = useState<ProductSortKey>('recent');
  const [sortDirection, setSortDirection] = useState<ProductSortDirection>('desc');
  const [selectedSku, setSelectedSku] = useState<string | null>(null);

  const sortedSkus = useMemo(() => {
    const next = [...safeSkus];
    const baseCompare = (a: Product, b: Product): number => {
      switch (sortKey) {
        case 'name':
          return a.name.localeCompare(b.name, 'ko', { sensitivity: 'base' });
        case 'sku':
          return a.sku.localeCompare(b.sku, 'ko', { sensitivity: 'base' });
        case 'recent':
        default: {
          const legacyDiff = (a.legacyProductId ?? 0) - (b.legacyProductId ?? 0);
          if (legacyDiff !== 0) {
            return legacyDiff;
          }
          return a.productId.localeCompare(b.productId, 'ko', { sensitivity: 'base' });
        }
      }
    };

    next.sort((a, b) => {
      const result = baseCompare(a, b);
      return sortDirection === 'asc' ? result : -result;
    });

    return next;
  }, [safeSkus, sortDirection, sortKey]);

  useEffect(() => {
    if (!selectedSku) {
      return;
    }

    const exists = safeSkus.some((row) => row.sku === selectedSku);
    if (!exists) {
      setSelectedSku(null);
    }
  }, [safeSkus, selectedSku]);

  const selectedProduct = useMemo(
    () => safeSkus.find((row) => row.sku === selectedSku) ?? null,
    [safeSkus, selectedSku],
  );

  const { total, active, inactive, riskCounts, categories, grades } = useMemo(() => {
    const riskBase: Record<InventoryRisk, number> = { [RISK_NORMAL]: 0, [RISK_STOCKOUT]: 0, [RISK_OVERSTOCK]: 0 };
    let activeCount = 0;
    const categoryMap = new Map<string, number>();
    const gradeMap = new Map<string, number>();

    safeSkus.forEach((row) => {
      if (row.isActive) {
        activeCount += 1;
      }
      riskBase[row.risk] += 1;

      const categoryKey = row.category?.trim() || '미분류';
      categoryMap.set(categoryKey, (categoryMap.get(categoryKey) ?? 0) + 1);

      const subCategoryKey = row.subCategory?.trim();
      if (subCategoryKey) {
        const fullKey = `${categoryKey} · ${subCategoryKey}`;
        categoryMap.set(fullKey, (categoryMap.get(fullKey) ?? 0) + 1);
      }

      const gradeKey = `${row.abcGrade}${row.xyzGrade}`;
      gradeMap.set(gradeKey, (gradeMap.get(gradeKey) ?? 0) + 1);
    });

    const sortedCategories = Array.from(categoryMap.entries()).sort((a, b) => b[1] - a[1]);
    const sortedGrades = Array.from(gradeMap.entries()).sort((a, b) => b[1] - a[1]);

    return {
      total: safeSkus.length,
      active: activeCount,
      inactive: safeSkus.length - activeCount,
      riskCounts: riskBase,
      categories: sortedCategories,
      grades: sortedGrades,
    };
  }, [safeSkus]);

  const topCategories = categories.slice(0, 3);
  const topGrades = grades.slice(0, 3);
  const riskSummaryLine = useMemo(() => {
    if (total === 0) {
      return '등록된 품목이 없습니다.';
    }
    return RISK_ORDER.map((risk) => {
      const count = riskCounts[risk];
      const ratio = total > 0 ? Math.round((count / total) * 100) : 0;
      return `${risk} ${count.toLocaleString()}개 (${ratio}%)`;
    }).join(' · ');
  }, [riskCounts, total]);

  const topCategoryLine = useMemo(() => {
    if (topCategories.length === 0) {
      return null;
    }
    return topCategories
      .map(([category, count]) => `${category} (${count.toLocaleString()}개)`)
      .join(', ');
  }, [topCategories]);

  const topGradeLine = useMemo(() => {
    if (topGrades.length === 0) {
      return null;
    }
    return topGrades
      .map(([grade, count]) => `${grade} (${count.toLocaleString()}개)`)
      .join(', ');
  }, [topGrades]);

  const handleSearchChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onQueryChange(event.target.value);
    },
    [onQueryChange],
  );

  return (
    <div className="p-6 space-y-6">
      <Card className="space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">품목 관리</h2>
            <p className="mt-1 text-sm text-slate-500">
              총 {total.toLocaleString()}개 품목 중 활성 {active.toLocaleString()}개 · 비활성 {inactive.toLocaleString()}개
            </p>
            <p className="mt-1 text-xs text-slate-500">{riskSummaryLine}</p>
            {topCategoryLine && (
              <p className="mt-1 text-xs text-slate-500">주요 카테고리: {topCategoryLine}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-100"
              onClick={onCsvDownload}
              disabled={csvDownloading}
            >
              {csvDownloading ? 'CSV 다운로드 중...' : 'CSV 템플릿' }
            </button>
            <button
              type="button"
              className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-600 transition hover:bg-indigo-100"
              onClick={onCsvUpload}
            >
              CSV 업로드
            </button>
            <button
              type="button"
              className="rounded-xl bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500"
              onClick={onNew}
            >
              신규 품목
            </button>
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <span>정렬</span>
              <select
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-600 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                value={`${sortKey}:${sortDirection}`}
                onChange={(event) => {
                  const [nextKey, nextDirection] = event.target.value.split(':') as [
                    ProductSortKey,
                    ProductSortDirection,
                  ];
                  setSortKey(nextKey);
                  setSortDirection(nextDirection);
                }}
              >
                {Object.entries(SORT_OPTION_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="sm:w-72">
            <label htmlFor="product-search" className="sr-only">
              SKU, 품명, 카테고리 검색
            </label>
            <input
              id="product-search"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              placeholder="SKU, 품명, 카테고리 검색"
              value={query}
              onChange={handleSearchChange}
            />
          </div>
          <div className="text-xs text-slate-500">
            상위 등급: {topGradeLine ?? '데이터 없음'}
          </div>
        </div>

        {csvStatus && (
          <div
            className={`rounded-xl border px-3 py-2 text-xs ${
              csvStatus.kind === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-rose-200 bg-rose-50 text-rose-600'
            }`}
          >
            {csvStatus.message}
          </div>
        )}

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600">
            <span>{error}</span>
            <button
              type="button"
              className="rounded-full border border-rose-200 px-2 py-0.5 text-[11px] font-medium text-rose-600 transition hover:border-rose-300 hover:bg-rose-100"
              onClick={onRetry}
            >
              다시 시도
            </button>
          </div>
        )}

        <div className="space-y-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <h3 className="text-lg font-semibold text-slate-900">품목 목록</h3>
            <div className="text-xs text-slate-500">
              {loading ? '품목을 불러오는 중입니다…' : `총 ${safeSkus.length.toLocaleString()}개 품목 표시 중`}
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
            <div className="overflow-hidden rounded-2xl border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">제품명</th>
                    <th className="px-3 py-2">SKU</th>
                    <th className="px-3 py-2">카테고리</th>
                    <th className="px-3 py-2">하위카테고리</th>
                    <th className="px-3 py-2 text-right">총수량</th>
                    <th className="px-3 py-2 text-right">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-slate-500">
                        품목을 불러오는 중입니다...
                      </td>
                    </tr>
                  ) : safeSkus.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-slate-500">
                        조건에 맞는 품목이 없습니다.
                      </td>
                    </tr>
                  ) : (
                    sortedSkus.map((row) => {
                    const isSelected = selectedSku === row.sku;
                    return (
                      <tr
                        key={row.sku}
                        data-testid="product-row"
                        data-product-name={row.name}
                        className={`border-b border-slate-100 last:border-transparent ${
                          isSelected ? 'bg-indigo-50/60' : 'hover:bg-slate-50'
                        } cursor-pointer transition`}
                        onClick={() => setSelectedSku(row.sku)}
                      >
                        <td className="px-3 py-3 align-top">
                          <div className="font-semibold text-slate-900">{row.name}</div>
                          {row.brand && (
                            <div className="mt-1 text-xs text-slate-500">{row.brand}</div>
                          )}
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="font-mono text-xs text-slate-600">{row.sku}</div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="text-sm text-slate-800">{row.category || '미분류'}</div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="text-sm text-slate-800">{row.subCategory || '세부 없음'}</div>
                        </td>
                        <td className="px-3 py-3 align-top text-right">
                          <div className="font-semibold text-slate-900">
                            {row.onHand.toLocaleString()} {row.unit || DEFAULT_UNIT}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="flex justify-end gap-1 text-xs">
                            <button
                              type="button"
                              className="rounded-lg border border-slate-200 px-2 py-1 text-slate-600 hover:border-slate-300 hover:text-slate-900"
                              onClick={(event) => {
                                event.stopPropagation();
                                onEdit(row);
                              }}
                            >
                              수정
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border border-rose-200 px-2 py-1 text-rose-600 hover:border-rose-300 hover:text-rose-700"
                              onClick={(event) => {
                                event.stopPropagation();
                                onDelete(row);
                              }}
                            >
                              삭제
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="min-h-[24rem]">
            <ProductDetailPanel product={selectedProduct} />
          </div>
        </div>
        </div>
      </Card>
    </div>
  );
};

const POLICY_DEFAULT_SERVICE_LEVEL = 95;
const POLICY_DEFAULT_LEAD_TIME_DAYS = 14;
const MIN_POLICY_HISTORY_MONTHS = 3;

const sanitizePolicyInteger = (value: number | null | undefined): number | null => {
  if (!Number.isFinite(value as number)) {
    return null;
  }
  const normalized = Math.max(Math.round(value as number), 0);
  return Number.isFinite(normalized) ? normalized : null;
};

const getDaysInMonthFromIso = (value: string): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return 30;
  }
  const year = Number.parseInt(match[1], 10);
  const monthIndex = Number.parseInt(match[2], 10) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) {
    return 30;
  }
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Number.isFinite(lastDay) && lastDay > 0 ? lastDay : 30;
};

const derivePolicyMetricsFromForecast = (
  forecast: ForecastResponse,
): { forecastDemand: number | null; demandStdDev: number | null; leadTimeDays: number | null } | null => {
  const historyPoints = forecast.timeline.filter(
    (point) => point.phase === 'history' && Number.isFinite(point.actual ?? Number.NaN),
  );

  if (historyPoints.length < MIN_POLICY_HISTORY_MONTHS) {
    return null;
  }

  const recentHistory = historyPoints.slice(-Math.max(MIN_POLICY_HISTORY_MONTHS, 1));
  const dailyValues = recentHistory
    .map((point) => {
      if (typeof point.actual !== 'number') {
        return null;
      }
      const daysInMonth = getDaysInMonthFromIso(point.date);
      if (daysInMonth <= 0) {
        return null;
      }
      return point.actual / daysInMonth;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));

  if (dailyValues.length < MIN_POLICY_HISTORY_MONTHS) {
    return null;
  }

  const mean = dailyValues.reduce((sum, value) => sum + value, 0) / dailyValues.length;
  const variance = dailyValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / dailyValues.length;
  const stdDev = Math.sqrt(Math.max(variance, 0));

  const leadTimeDays = Number.isFinite(forecast.product.leadTimeDays)
    ? Math.max(Math.round(forecast.product.leadTimeDays), 0)
    : null;

  return {
    forecastDemand: Math.max(Math.round(mean), 0),
    demandStdDev: Math.max(Math.round(stdDev), 0),
    leadTimeDays,
  };
};

interface CreatePolicyOptions {
  forecast?: ForecastResponse | null;
  serviceLevelPercent?: number | null;
}

const createPolicyFromProduct = (product: Product, options: CreatePolicyOptions = {}): PolicyRow => {
  const fallbackDemand = sanitizePolicyInteger(product.dailyAvg);
  const fallbackStdDev = sanitizePolicyInteger(product.dailyStd);
  const fallbackLeadTime = sanitizePolicyInteger(POLICY_DEFAULT_LEAD_TIME_DAYS);

  const derived = options.forecast ? derivePolicyMetricsFromForecast(options.forecast) : null;

  const forecastDemand = sanitizePolicyInteger(
    (derived && derived.forecastDemand !== null ? derived.forecastDemand : null) ?? fallbackDemand ?? null,
  );
  const demandStdDev = sanitizePolicyInteger(
    (derived && derived.demandStdDev !== null ? derived.demandStdDev : null) ?? fallbackStdDev ?? null,
  );
  const leadTimeDays = sanitizePolicyInteger(
    (derived && derived.leadTimeDays !== null ? derived.leadTimeDays : null) ?? fallbackLeadTime ?? null,
  );

  const serviceLevelPercent =
    typeof options.serviceLevelPercent === 'number' && Number.isFinite(options.serviceLevelPercent)
      ? options.serviceLevelPercent
      : POLICY_DEFAULT_SERVICE_LEVEL;

  return {
    sku: normalizeSku(product.sku),
    name: product.name.trim() || null,
    forecastDemand,
    demandStdDev,
    leadTimeDays,
    serviceLevelPercent,
    smoothingAlpha: FALLBACK_SMOOTHING_ALPHA,
    corrRho: FALLBACK_CORRELATION_RHO,
  };
};

interface PoliciesPageProps {
  skus: Product[];
  allProducts: Product[];
  policyRows: PolicyRow[];
  setPolicyRows: React.Dispatch<React.SetStateAction<PolicyRow[]>>;
  forecastCache: Record<string, ForecastResponse>;
  loading?: boolean;
  loadError?: string | null;
  onReload?: () => void;
  persistedManualSkus?: string[];
  ready?: boolean;
  onPersistedSkusChange?: (skus: string[]) => void;
}

interface PolicyCreateDialogProps {
  open: boolean;
  products: Product[];
  existingSkus: ReadonlySet<string>;
  onClose: () => void;
  onSubmit: (product: Product) => void;
}

const PolicyCreateDialog: React.FC<PolicyCreateDialogProps> = ({
  open,
  products,
  existingSkus,
  onClose,
  onSubmit,
}) => {
  const [keyword, setKeyword] = useState('');
  const [candidateSku, setCandidateSku] = useState('');

  const availableProducts = useMemo(() => {
    const term = keyword.trim().toLowerCase();

    return products
      .filter((product) => !existingSkus.has(normalizeSku(product.sku)))
      .filter((product) => {
        if (!term) {
          return true;
        }

        const name = product.name?.toLowerCase() ?? '';
        return product.sku.toLowerCase().includes(term) || name.includes(term);
      });
  }, [existingSkus, keyword, products]);

  useEffect(() => {
    if (!open) {
      setKeyword('');
      setCandidateSku('');
      return;
    }

    setCandidateSku((prev) => {
      if (
        prev &&
        availableProducts.some((product) => normalizeSku(product.sku) === normalizeSku(prev))
      ) {
        return prev;
      }
      return availableProducts[0]?.sku ?? '';
    });
  }, [availableProducts, open]);

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!candidateSku) {
        return;
      }

      const product = availableProducts.find(
        (item) => normalizeSku(item.sku) === normalizeSku(candidateSku),
      );
      if (!product) {
        return;
      }

      onSubmit(product);
      onClose();
    },
    [availableProducts, candidateSku, onClose, onSubmit],
  );

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 px-4 py-8">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">정책 추가</h3>
            <p className="mt-1 text-sm text-slate-500">정책을 적용할 SKU를 선택하세요.</p>
          </div>
          <button
            type="button"
            className="rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            onClick={onClose}
            aria-label="정책 추가 닫기"
          >
            <span aria-hidden>×</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="policy-add-search" className="text-sm font-medium text-slate-700">
              검색어
            </label>
            <input
              id="policy-add-search"
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              placeholder="SKU 또는 품명을 입력하세요"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>

          <div>
            <label htmlFor="policy-add-sku" className="text-sm font-medium text-slate-700">
              SKU 선택
            </label>
            {availableProducts.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">추가 가능한 SKU가 없습니다.</p>
            ) : (
              <select
                id="policy-add-sku"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                value={candidateSku}
                onChange={(event) => setCandidateSku(event.target.value)}
              >
                {availableProducts.map((product) => (
                  <option key={product.sku} value={product.sku}>
                    {product.sku} · {product.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900"
              onClick={onClose}
            >
              취소
            </button>
            <button
              type="submit"
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
              disabled={!candidateSku || availableProducts.length === 0}
            >
              추가
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface PolicyEditDialogProps {
  open: boolean;
  sku: string;
  productName?: string;
  value: {
    forecastDemand: number | null;
    demandStdDev: number | null;
    leadTimeDays: number | null;
    serviceLevelPercent: number | null;
  };
  onClose: () => void;
  onSubmit: (next: {
    forecastDemand: number | null;
    demandStdDev: number | null;
    leadTimeDays: number | null;
    serviceLevelPercent: number | null;
  }) => void;
  onRecommend?: (sku: string) => Promise<ForecastRecommendationResult>;
  onApplyEwma?: (sku: string, alpha: number | null) => Promise<{
    forecastDemand: number | null;
    demandStdDev: number | null;
    smoothingAlpha: number | null;
  }>;
  onAutoSave?: (next: {
    forecastDemand: number | null;
    demandStdDev: number | null;
    leadTimeDays: number | null;
    serviceLevelPercent: number | null;
  }) => Promise<void>;
}

const PolicyEditDialog: React.FC<PolicyEditDialogProps> = ({
  open,
  sku,
  productName,
  value,
  onClose,
  onSubmit,
  onRecommend,
  onApplyEwma,
  onAutoSave,
}) => {
  const [demand, setDemand] = useState<string>(value.forecastDemand?.toString() ?? '');
  const [std, setStd] = useState<string>(value.demandStdDev?.toString() ?? '');
  const [lead, setLead] = useState<string>(value.leadTimeDays?.toString() ?? '');
  const [service, setService] = useState<string>(value.serviceLevelPercent?.toString() ?? '');
  const [recommendation, setRecommendation] = useState<ForecastRecommendationResult | null>(null);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisInfo, setAnalysisInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDemand(value.forecastDemand?.toString() ?? '');
    setStd(value.demandStdDev?.toString() ?? '');
    setLead(value.leadTimeDays?.toString() ?? '');
    setService(value.serviceLevelPercent?.toString() ?? '');
    setRecommendation(null);
    setRecommendationError(null);
    setRecommendationLoading(false);
    setAnalysisError(null);
    setAnalysisInfo(null);
  }, [
    open,
    value.forecastDemand,
    value.demandStdDev,
    value.leadTimeDays,
    value.serviceLevelPercent,
  ]);

  const toNonNegativeInt = (text: string): number | null => {
    const t = (text ?? '').trim();
    if (!t) return null;
    const n = Number.parseFloat(t);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.round(n));
  };

  const toServicePercent = (text: string): number | null => {
    const t = (text ?? '').trim();
    if (!t) return null;
    const n = Number.parseFloat(t);
    if (!Number.isFinite(n)) return null;
    return Math.max(50, Math.min(99.9, Math.round(n * 10) / 10));
  };

  const zValue = useMemo(() => {
    const p = toServicePercent(service);
    return Number.isFinite(p as number) ? serviceLevelPercentageToZ(p as number) : null;
  }, [service]);

  const appendAnalysisInfo = useCallback((message: string) => {
    setAnalysisInfo((prev) => {
      if (!prev) {
        return message;
      }
      if (prev.includes(message)) {
        return prev;
      }
      return `${prev} · ${message}`;
    });
  }, []);

  const handleRecommendClick = useCallback(async () => {
    if (!onRecommend) {
      return;
    }
    setRecommendationError(null);
    setRecommendation(null);
    setRecommendationLoading(true);
    setAnalysisError(null);
    setAnalysisInfo(null);
    try {
      const result = await onRecommend(sku);
      let merged = result;
      if (onApplyEwma) {
        try {
          const ewma = await onApplyEwma(sku, FALLBACK_SMOOTHING_ALPHA);
          merged = {
            ...result,
            forecastDemand: ewma.forecastDemand ?? result.forecastDemand,
            demandStdDev: ewma.demandStdDev ?? result.demandStdDev,
          };
          appendAnalysisInfo(
            `최근 ${EWMA_ANALYSIS_DAYS.toLocaleString()}일 출고 데이터를 기준으로 EWMA(α=${FALLBACK_SMOOTHING_ALPHA}) 값을 적용했습니다.`,
          );
        } catch (error) {
          const message =
            error instanceof Error && error.message
              ? error.message
              : '기간 출고 데이터를 반영하지 못했습니다.';
          setAnalysisError(message);
        }
      }
      const nextValues = {
        forecastDemand: merged.forecastDemand ?? toNonNegativeInt(demand),
        demandStdDev: merged.demandStdDev ?? toNonNegativeInt(std),
        leadTimeDays: merged.leadTimeDays ?? toNonNegativeInt(lead),
        serviceLevelPercent: merged.serviceLevelPercent ?? toServicePercent(service),
      };
      setRecommendation(merged);
      if (merged.forecastDemand !== null) {
        setDemand(merged.forecastDemand.toString());
      }
      if (merged.demandStdDev !== null) {
        setStd(merged.demandStdDev.toString());
      }
      if (merged.leadTimeDays !== null) {
        setLead(merged.leadTimeDays.toString());
      }
      if (merged.serviceLevelPercent !== null) {
        const formatted = Math.round(merged.serviceLevelPercent * 10) / 10;
        setService(formatted.toString());
      }

      if (onAutoSave) {
        try {
          await onAutoSave(nextValues);
          appendAnalysisInfo('추천값을 자동 적용하고 저장했습니다.');
        } catch (error) {
          const message =
            error instanceof Error && error.message
              ? error.message
              : '추천값을 자동 저장하지 못했습니다.';
          setRecommendationError(message);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : '정책을 불러오지 못했습니다.';
      setRecommendationError(message);
    } finally {
      setRecommendationLoading(false);
    }
  }, [appendAnalysisInfo, demand, lead, onApplyEwma, onAutoSave, onRecommend, service, sku, std]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl ring-1 ring-slate-200">
        <div className="mb-3">
          <h3 className="text-lg font-semibold text-slate-900">정책 수정</h3>
          <p className="mt-1 text-sm text-slate-500">
            {productName ?? sku} <span className="font-mono text-xs text-slate-400">({sku})</span>
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit({
              forecastDemand: toNonNegativeInt(demand),
              demandStdDev: toNonNegativeInt(std),
              leadTimeDays: toNonNegativeInt(lead),
              serviceLevelPercent: toServicePercent(service),
            });
          }}
          className="space-y-3"
        >
          <div>
            <label className="text-sm font-medium text-slate-700" htmlFor="policy-edit-forecast-demand">예측 수요량 (EA/일)</label>
            <input
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              inputMode="numeric"
              id="policy-edit-forecast-demand"
              value={demand}
              onChange={(e) => setDemand(e.target.value)}
              placeholder="예: 320"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-700" htmlFor="policy-edit-demand-std">수요 표준편차 (σ)</label>
            <input
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              inputMode="numeric"
              id="policy-edit-demand-std"
              value={std}
              onChange={(e) => setStd(e.target.value)}
              placeholder="예: 48"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-700" htmlFor="policy-edit-lead-time">리드타임 (L, 일)</label>
            <input
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              inputMode="numeric"
              id="policy-edit-lead-time"
              value={lead}
              onChange={(e) => setLead(e.target.value)}
              placeholder="예: 10"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-700" htmlFor="policy-edit-service-level">서비스 수준 (%)</label>
            <div className="mt-1 flex items-center gap-2">
              <select
                className="w-36 rounded-xl border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                id="policy-edit-service-level"
                value={service}
                onChange={(e) => setService(e.target.value)}
              >
                {service === '' && <option value="">선택</option>}
                {SERVICE_LEVEL_PRESETS.map((preset) => (
                  <option key={preset} value={preset.toString()}>
                    {Number.isInteger(preset) ? preset.toFixed(0) : preset.toFixed(1)}%
                  </option>
                ))}
              </select>
              <div className="text-xs text-slate-500">{zValue !== null ? `Z ? ${zValue.toFixed(2)}` : 'Z -'}</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 shadow-sm transition hover:border-indigo-300 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={handleRecommendClick}
              disabled={recommendationLoading || !onRecommend}
            >
              {recommendationLoading ? '산출 중...' : '추천값 자동산출'}
            </button>
          </div>

          {recommendationError && (
            <p className="mt-2 text-xs text-rose-500">{recommendationError}</p>
          )}

          {analysisError && (
            <p className="mt-2 text-xs text-rose-500">{analysisError}</p>
          )}

          {analysisInfo && (
            <p className="mt-2 text-xs text-emerald-600">{analysisInfo}</p>
          )}

          {recommendation && (
            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              <p>예측 수요량: {recommendation.forecastDemand ?? '-'} EA/일</p>
              <p>수요 표준편차: {recommendation.demandStdDev ?? '-'} EA/일</p>
              <p>리드타임: {recommendation.leadTimeDays ?? '-'} 일</p>
              <p>서비스 수준: {recommendation.serviceLevelPercent ?? '-'}%</p>
              {recommendation.notes.length > 0 && (
                <ul className="mt-2 list-disc pl-4 text-[11px] text-slate-500">
                  {recommendation.notes.map((note, index) => (
                    <li key={`${sku}-recommendation-note-${index}`}>{note}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="pt-2 text-right">
            <button
              type="button"
              className="mr-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900"
              onClick={onClose}
            >
              취소
            </button>
            <button
              type="submit"
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
            >
              저장
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface BulkApplyDialogProps {
  open: boolean;
  options: BulkApplyOptions;
  targetCount: number;
  targetContext: BulkApplyTargetContext;
  applying: boolean;
  progress: BulkApplyProgress | null;
  summary: BulkApplyResultSummary | null;
  onClose: () => void;
  onConfirm: () => void;
  onOptionChange: (next: Partial<BulkApplyOptions>) => void;
  disabled?: boolean;
}

const BulkApplyDialog: React.FC<BulkApplyDialogProps> = ({
  open,
  options,
  targetCount,
  targetContext,
  applying,
  progress,
  summary,
  onClose,
  onConfirm,
  onOptionChange,
  disabled = false,
}) => {
  if (!open) {
    return null;
  }

  const handleOptionChange = (partial: Partial<BulkApplyOptions>) => {
    onOptionChange({ ...options, ...partial });
  };

  const confirmLabel = summary
    ? '다시 적용'
    : applying
      ? '적용 중...'
      : targetCount > 0
        ? `적용 시작 (${targetCount.toLocaleString()}건)`
        : '적용할 정책이 없습니다';

  const cancelLabel = summary ? '닫기' : '취소';
  const confirmDisabled = disabled || applying || targetCount === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-8">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">전체 추천값 일괄 적용</h3>
            <p className="mt-1 text-sm text-slate-500">
              검색어 입력 여부에 따라 대상을 자동으로 정해 추천값을 다시 계산해 저장합니다.
            </p>
          </div>
          <button
            type="button"
            className="rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            onClick={onClose}
            aria-label="전체 추천값 일괄 적용 닫기"
            disabled={applying}
          >
            <span aria-hidden>×</span>
          </button>
        </div>

        <div className="mt-4 space-y-5">
          <section className="rounded-xl border border-slate-200 p-4">
            <p className="text-sm font-medium text-slate-700">덮어쓰기 규칙</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm shadow-sm transition hover:border-indigo-200">
                <input
                  type="radio"
                  name="bulk-mode"
                  className="mt-1 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                  checked={options.mode === 'fill'}
                  onChange={() => handleOptionChange({ mode: 'fill' })}
                  disabled={applying}
                />
                <span>
                  <span className="font-semibold text-slate-900">빈 값만 채우기 (기본)</span>
                  <span className="mt-1 block text-xs text-slate-500">
                    예측 수요/표준편차가 비어 있는 SKU만 추천값으로 채웁니다.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm shadow-sm transition hover:border-indigo-200">
                <input
                  type="radio"
                  name="bulk-mode"
                  className="mt-1 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                  checked={options.mode === 'overwrite'}
                  onChange={() => handleOptionChange({ mode: 'overwrite' })}
                  disabled={applying}
                />
                <span>
                  <span className="font-semibold text-slate-900">모든 값 덮어쓰기</span>
                  <span className="mt-1 block text-xs text-slate-500">
                    예측 수요와 표준편차를 현재 추천값으로 덮어씁니다. ±20% 이상 변동은 보류합니다.
                  </span>
                </span>
              </label>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="flex items-start gap-3 rounded-lg border border-slate-100 p-3 text-sm shadow-sm">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                  checked={options.includeLeadTime}
                  onChange={(event) => handleOptionChange({ includeLeadTime: event.target.checked })}
                  disabled={applying}
                />
                <span>
                  <span className="font-semibold text-slate-900">리드타임도 갱신</span>
                  <span className="mt-1 block text-xs text-slate-500">
                    추천 리드타임을 적용합니다. 빈 값만 채우기 모드에서는 비어 있을 때만 반영합니다.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-slate-100 p-3 text-sm shadow-sm">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                  checked={options.includeServiceLevel}
                  onChange={(event) => handleOptionChange({ includeServiceLevel: event.target.checked })}
                  disabled={applying}
                />
                <span>
                  <span className="font-semibold text-slate-900">서비스 수준도 갱신</span>
                  <span className="mt-1 block text-xs text-slate-500">
                    추천 서비스 수준을 적용합니다. 조직의 목표 값과 다를 경우 주의하세요.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-slate-100 p-3 text-sm shadow-sm md:col-span-2">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                  checked={options.includeManual}
                  onChange={(event) => handleOptionChange({ includeManual: event.target.checked })}
                  disabled={applying}
                />
                <span>
                  <span className="font-semibold text-slate-900">수동관리 SKU 포함(강제 적용)</span>
                  <span className="mt-1 block text-xs text-slate-500">
                    기본은 수동으로 관리 중인 SKU를 자동 적용에서 제외합니다. 체크 시 해당 SKU도 포함됩니다.
                  </span>
                </span>
              </label>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-900">대상 SKU</span>
              <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-600">
                {targetContext === 'search' ? '현재 검색 결과' : '모든 SKU'}
              </span>
              <span className="rounded-full bg-white px-3 py-1 text-xs text-slate-500 shadow-sm">
                {targetCount.toLocaleString()}건
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {targetContext === 'search'
                ? '검색어가 입력된 동안에는 해당 검색 결과 전체에만 적용합니다.'
                : '검색어가 없으므로 등록된 모든 SKU에 적용합니다.'}
            </p>
            {applying && progress && (
              <p className="mt-2 text-xs text-indigo-600">
                진행 중: {progress.completed.toLocaleString()} / {progress.total.toLocaleString()}
              </p>
            )}
            {summary && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">
                <p>
                  총 {summary.total.toLocaleString()}건 중{' '}
                  <span className="font-semibold text-emerald-600">
                    {summary.applied.toLocaleString()}건
                  </span>
                  을 적용했습니다.
                </p>
                <p className="mt-1">
                  건너뜀 {summary.skipped.length.toLocaleString()}건 · 실패{' '}
                  {summary.failed.length.toLocaleString()}건
                </p>
                {(summary.skipped.length > 0 || summary.failed.length > 0) && (
                  <div className="mt-2 max-h-32 overflow-auto rounded border border-slate-100 bg-slate-50 p-2">
                    {summary.skipped.length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold text-slate-700">건너뜀</p>
                        <ul className="mt-1 text-[11px] text-slate-500">
                          {summary.skipped.map((entry) => (
                            <li key={`skip-${entry.sku}`}>
                              {entry.sku}: {entry.reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {summary.failed.length > 0 && (
                      <div className="mt-2">
                        <p className="text-[11px] font-semibold text-rose-700">실패</p>
                        <ul className="mt-1 text-[11px] text-rose-600">
                          {summary.failed.map((entry) => (
                            <li key={`fail-${entry.sku}`}>
                              {entry.sku}: {entry.reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button
            type="button"
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900"
            onClick={onClose}
            disabled={applying}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
            onClick={onConfirm}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

const PoliciesPage: React.FC<PoliciesPageProps> = ({
  skus,
  allProducts,
  policyRows,
  setPolicyRows,
  forecastCache,
  loading = false,
  loadError = null,
  onReload,
  persistedManualSkus = [],
  ready = false,
  onPersistedSkusChange,
}) => {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const manualOverrideRef = useRef<Set<string>>(new Set());
  const [editOpen, setEditOpen] = useState(false);
  const [editSku, setEditSku] = useState<string | null>(null);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkOptions, setBulkOptions] = useState<BulkApplyOptions>(DEFAULT_BULK_APPLY_OPTIONS);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<BulkApplyProgress | null>(null);
  const [bulkSummary, setBulkSummary] = useState<BulkApplyResultSummary | null>(null);

  useEffect(() => {
    manualOverrideRef.current.clear();
    if (!persistedManualSkus || persistedManualSkus.length === 0) {
      return;
    }

    persistedManualSkus.forEach((sku) => {
      manualOverrideRef.current.add(normalizeSku(sku));
    });
  }, [persistedManualSkus]);

  const markManualOverride = useCallback((sku: string) => {
    manualOverrideRef.current.add(normalizeSku(sku));
  }, []);

  const addManualSku = useCallback(
    (sku: string) => {
      if (!onPersistedSkusChange) {
        return;
      }
      const normalized = normalizeSku(sku);
      const prev = persistedManualSkus ?? [];
      if (prev.includes(normalized)) {
        return;
      }
      onPersistedSkusChange([...prev, normalized]);
    },
    [onPersistedSkusChange, persistedManualSkus],
  );

  const removeManualSku = useCallback(
    (sku: string) => {
      if (!onPersistedSkusChange) {
        return;
      }
      const normalized = normalizeSku(sku);
      const prev = persistedManualSkus ?? [];
      if (prev.length === 0) {
        return;
      }
      const next = prev.filter((entry) => entry !== normalized);
      if (next.length === prev.length) {
        return;
      }
      onPersistedSkusChange(next);
    },
    [onPersistedSkusChange, persistedManualSkus],
  );

  const openBulkApplyDialog = useCallback(() => {
    setBulkSummary(null);
    setBulkProgress(null);
    setBulkDialogOpen(true);
  }, []);

  const closeBulkApplyDialog = useCallback(() => {
    if (bulkApplying) {
      return;
    }
    setBulkDialogOpen(false);
  }, [bulkApplying]);

  const handleBulkOptionChange = useCallback((partial: Partial<BulkApplyOptions>) => {
    setBulkSummary(null);
    setBulkOptions((prev) => ({ ...prev, ...partial }));
  }, []);

  const showInitialLoading = !ready && loading;
  const showRefreshing = ready && loading;
  const canInteract = ready || policyRows.length > 0;

  const productBySku = useMemo(() => {
    const map = new Map<string, Product>();
    allProducts.forEach((row) => {
      const normalized = normalizeSku(row.sku);
      map.set(normalized, row);
      if (normalized !== row.sku) {
        map.set(row.sku, row);
      }
    });
    return map;
  }, [allProducts]);

  const existingSkuSet = useMemo(
    () => new Set(policyRows.map((row) => normalizeSku(row.sku))),
    [policyRows],
  );
  const availableSkus = useMemo(
    () => allProducts.filter((product) => !existingSkuSet.has(normalizeSku(product.sku))),
    [allProducts, existingSkuSet],
  );
  const canAddPolicy = availableSkus.length > 0;
  const canTriggerPolicyCreate = !saving;

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) {
      return policyRows;
    }

    return policyRows.filter((row) => {
      const normalized = normalizeSku(row.sku);
      const product = productBySku.get(normalized);
      const name = product?.name?.toLowerCase() ?? '';
      return normalized.toLowerCase().includes(term) || name.includes(term);
    });
  }, [policyRows, productBySku, search]);

  const registeredRows = useMemo(() => {
    if (productBySku.size === 0) {
      return [];
    }
    return filteredRows.filter((row) => productBySku.has(normalizeSku(row.sku)));
  }, [filteredRows, productBySku]);

  const isSearchFiltering = search.trim().length > 0;
  const bulkTargetContext: BulkApplyTargetContext = isSearchFiltering ? 'search' : 'all';

  const bulkTargetCount = useMemo(() => {
    const source = isSearchFiltering ? registeredRows : policyRows;
    if (!source || source.length === 0) {
      return 0;
    }
    const seen = new Set<string>();
    let count = 0;
    source.forEach((row) => {
      const normalized = normalizeSku(row.sku);
      if (seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      if (productBySku.has(normalized)) {
        count += 1;
      }
    });
    return count;
  }, [isSearchFiltering, policyRows, productBySku, registeredRows]);

  const handleForecastRecommendation = useCallback(
    async (targetSku: string): Promise<ForecastRecommendationResult> => {
      const normalized = normalizeSku(targetSku);
      const product = productBySku.get(normalized);
      const policy = policyRows.find((row) => normalizeSku(row.sku) === normalized);
      const forecast = forecastCache[normalized] ?? forecastCache[targetSku];

      const metrics: ForecastRecommendationPayload['metrics'] = {};
      if (typeof product?.dailyAvg === 'number' && Number.isFinite(product.dailyAvg)) {
        metrics.dailyAvg = product.dailyAvg;
      }
      if (typeof product?.dailyStd === 'number' && Number.isFinite(product.dailyStd)) {
        metrics.dailyStd = product.dailyStd;
      }
      if (typeof product?.avgOutbound7d === 'number' && Number.isFinite(product.avgOutbound7d)) {
        metrics.avgOutbound7d = product.avgOutbound7d;
      }
      if (typeof product?.onHand === 'number' && Number.isFinite(product.onHand)) {
        metrics.onHand = product.onHand;
      }
      const leadTimeCandidate = policy?.leadTimeDays ?? forecast?.product?.leadTimeDays;
      if (typeof leadTimeCandidate === 'number' && Number.isFinite(leadTimeCandidate)) {
        metrics.leadTimeDays = leadTimeCandidate;
      }
      if (typeof policy?.serviceLevelPercent === 'number' && Number.isFinite(policy.serviceLevelPercent)) {
        metrics.serviceLevelPercent = policy.serviceLevelPercent;
      }

      const payload: ForecastRecommendationPayload = {
        sku: normalized,
        name: product?.name ?? targetSku,
        category: product?.category,
        metrics: Object.keys(metrics).length > 0 ? metrics : undefined,
        history: forecast?.timeline?.map((entry) => ({
          date: entry.date,
          actual: entry.actual,
          forecast: entry.forecast,
        })),
      };

      return requestForecastRecommendation(payload);
    },
    [forecastCache, policyRows, productBySku],
  );

  const handleBulkApplyConfirm = useCallback(async () => {
    if (bulkApplying) {
      return;
    }

    const sourceRows = isSearchFiltering ? registeredRows : policyRows;
    const targetSkus = Array.from(
      new Set(
        sourceRows
          .map((row) => normalizeSku(row.sku))
          .filter((sku) => sku && productBySku.has(sku)),
      ),
    );

    if (targetSkus.length === 0) {
      setStatus({ type: 'error', text: '적용할 정책을 찾지 못했습니다.' });
      setBulkDialogOpen(false);
      return;
    }

    const skipped: Array<{ sku: string; reason: string }> = [];
    const failed: Array<{ sku: string; reason: string }> = [];

    const actionable = targetSkus.filter((sku) => {
      if (manualOverrideRef.current.has(sku) && !bulkOptions.includeManual) {
        skipped.push({ sku, reason: '수동으로 관리 중인 SKU라 자동 적용하지 않았습니다.' });
        return false;
      }
      return true;
    });

    if (actionable.length === 0) {
      setBulkSummary({
        total: targetSkus.length,
        applied: 0,
        skipped,
        failed,
      });
      setStatus({ type: 'error', text: '자동 적용 가능한 SKU가 없습니다.' });
      return;
    }

    setBulkApplying(true);
    setBulkProgress({ total: actionable.length, completed: 0 });
    setBulkSummary(null);
    setStatus(null);

    const updates = new Map<string, PolicyRow>();

    for (let index = 0; index < actionable.length; index += 1) {
      const sku = actionable[index];
      const currentRow = policyRows.find((row) => normalizeSku(row.sku) === sku);
      if (!currentRow) {
        skipped.push({ sku, reason: '정책 데이터를 찾지 못했습니다.' });
        setBulkProgress({ total: actionable.length, completed: index + 1 });
        continue;
      }

      try {
        const recommendation = await handleForecastRecommendation(sku);
        const sanitized = sanitizeRecommendationValues(recommendation);
        const result = applyBulkRecommendationToRow(currentRow, sanitized, bulkOptions);
        if (result.changed && result.nextRow) {
          updates.set(sku, result.nextRow);
        } else {
          skipped.push({
            sku,
            reason: result.reason ?? '적용할 변경이 없습니다.',
          });
        }
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : '추천값을 가져오지 못했습니다.';
        failed.push({ sku, reason: message });
      }

      setBulkProgress({ total: actionable.length, completed: index + 1 });
    }

    const totalApplied = updates.size;
    let saveErrorMessage: string | null = null;
    let nextRowsSnapshot: PolicyRow[] | null = null;

    if (totalApplied > 0) {
      nextRowsSnapshot = policyRows
        .map((row) => {
          const normalized = normalizeSku(row.sku);
          const updated = updates.get(normalized);
          return updated ?? row;
        })
        .sort((a, b) => a.sku.localeCompare(b.sku));

      try {
        await savePolicies(nextRowsSnapshot);
        setPolicyRows(nextRowsSnapshot);
        setStatus({
          type: 'success',
          text: `추천값을 ${totalApplied.toLocaleString()}건 적용했습니다.`,
        });
      } catch (error) {
        saveErrorMessage =
          error instanceof Error && error.message
            ? error.message
            : '정책 저장에 실패했습니다. 값은 화면에만 반영되었습니다.';
        setPolicyRows(nextRowsSnapshot);
        setStatus({ type: 'error', text: saveErrorMessage });
      }
    } else if (failed.length === 0) {
      setStatus({ type: 'error', text: '적용 가능한 추천값을 찾지 못했습니다.' });
    }

    setBulkSummary({
      total: targetSkus.length,
      applied: totalApplied,
      skipped,
      failed,
    });

    if (saveErrorMessage) {
      console.error('[policy] bulk apply save failed', saveErrorMessage);
    }

    setBulkApplying(false);
    setBulkProgress(null);
  }, [
    bulkApplying,
    bulkOptions,
    handleForecastRecommendation,
    isSearchFiltering,
    onPersistedSkusChange,
    policyRows,
    productBySku,
    registeredRows,
    savePolicies,
    setPolicyRows,
    setStatus,
  ]);

  const handlePolicyEwma = useCallback(
    async (targetSku: string, _alphaHint: number | null) => {
      const normalized = normalizeSku(targetSku);
      const policy = policyRows.find((row) => normalizeSku(row.sku) === normalized);
      const appliedAlpha = FALLBACK_SMOOTHING_ALPHA;

      const today = new Date();
      const toDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      const fromDate = new Date(toDate);
      fromDate.setUTCDate(fromDate.getUTCDate() - (EWMA_ANALYSIS_DAYS - 1));

      const analysis = await fetchInventoryAnalysis({
        from: formatIsoDateUtc(fromDate),
        to: formatIsoDateUtc(toDate),
        sku: normalized,
      });

      if (!analysis.movementSeries || analysis.movementSeries.length === 0) {
        throw new Error('최근 기간에 출고 데이터가 없어 갱신할 수 없습니다.');
      }

      const dailyOutbounds = analysis.movementSeries.map((point) =>
        Number.isFinite(point.outbound) ? Math.max(point.outbound, 0) : 0,
      );

      const validCount = dailyOutbounds.length;
      if (validCount === 0) {
        throw new Error('출고 데이터가 부족해 EWMA를 계산할 수 없습니다.');
      }

      const rawMean = Number.isFinite(analysis.totals.avgDailyOutbound)
        ? Math.max(0, analysis.totals.avgDailyOutbound)
        : dailyOutbounds.reduce((sum, value) => sum + value, 0) / validCount;

      const variance =
        dailyOutbounds.reduce((sum, value) => sum + (value - rawMean) ** 2, 0) / Math.max(validCount, 1);
      const rawStd = Math.sqrt(Math.max(variance, 0));

      const smoothValue = (raw: number, previous: number | null): number | null => {
        if (!Number.isFinite(raw)) {
          return previous !== null && Number.isFinite(previous)
            ? Math.max(0, Math.round(previous))
            : null;
        }
        const base = Math.max(0, raw);
        if (!Number.isFinite(appliedAlpha) || appliedAlpha === null) {
          return Math.max(0, Math.round(base));
        }
        if (previous === null || !Number.isFinite(previous)) {
          return Math.max(0, Math.round(base));
        }
        return Math.max(0, Math.round(appliedAlpha * base + (1 - appliedAlpha) * previous));
      };

      const previousDemand =
        typeof policy?.forecastDemand === 'number' && Number.isFinite(policy.forecastDemand)
          ? policy.forecastDemand
          : null;
      const previousStd =
        typeof policy?.demandStdDev === 'number' && Number.isFinite(policy.demandStdDev)
          ? policy.demandStdDev
          : null;

      const nextDemand = smoothValue(rawMean, previousDemand);
      const nextStd = smoothValue(rawStd, previousStd);

      return {
        forecastDemand: nextDemand,
        demandStdDev: nextStd,
        smoothingAlpha: appliedAlpha,
      };
    },
    [policyRows],
  );


  useEffect(() => {
    if (!forecastCache || Object.keys(forecastCache).length === 0) {
      return;
    }

    setPolicyRows((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        const normalized = normalizeSku(row.sku);
        if (manualOverrideRef.current.has(normalized)) {
          return row;
        }

        const product = productBySku.get(normalized);
        if (!product) {
          return row;
        }

        const forecast = forecastCache[normalized] ?? forecastCache[row.sku];
        if (!forecast) {
          return row;
        }

        const draft = createPolicyFromProduct(product, {
          forecast,
          serviceLevelPercent: row.serviceLevelPercent,
        });

        const merged: PolicyRow = {
          ...row,
          forecastDemand: draft.forecastDemand ?? row.forecastDemand,
          demandStdDev: draft.demandStdDev ?? row.demandStdDev,
          leadTimeDays: draft.leadTimeDays ?? row.leadTimeDays,
        };

        if (
          merged.forecastDemand !== row.forecastDemand ||
          merged.demandStdDev !== row.demandStdDev ||
          merged.leadTimeDays !== row.leadTimeDays
        ) {
          changed = true;
        }

        return merged;
      });

      return changed ? next : prev;
    });
  }, [forecastCache, productBySku, setPolicyRows]);

  const formatNumber = useCallback((value: number | null | undefined, fractionDigits = 0): string => {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return '-';
    }
    return value.toLocaleString(undefined, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
  }, []);

  const handleServiceLevelChange = useCallback(
    (sku: string, nextValue: string) => {
      if (!canInteract) {
        return;
      }

      const parsed = Number.parseFloat(nextValue);
      if (!Number.isFinite(parsed)) {
        return;
      }

      const normalizedSku = normalizeSku(sku);
      setPolicyRows((prev) =>
        prev.map((row) =>
          normalizeSku(row.sku) === normalizedSku ? { ...row, serviceLevelPercent: parsed } : row,
        ),
      );
      markManualOverride(sku);
      addManualSku(sku);
    },
    [addManualSku, canInteract, markManualOverride, setPolicyRows],
  );

  const handleEditPolicy = useCallback(
    (sku: string) => {
      if (!canInteract) {
        return;
      }
      const normalizedSku = normalizeSku(sku);
      const targetRow = policyRows.find((row) => normalizeSku(row.sku) === normalizedSku);
      if (!targetRow) {
        setStatus({ type: 'error', text: '선택한 SKU 정책이 존재하지 않습니다.' });
        return;
      }
      setEditSku(targetRow.sku);
      setEditOpen(true);
    },
    [canInteract, policyRows, setStatus],
  );

  const handleDeletePolicy = useCallback(
    (sku: string) => {
      if (!canInteract) {
        return;
      }

      const normalizedSku = normalizeSku(sku);
      const product = productBySku.get(normalizedSku);
      const confirmMessage = product
        ? `'${product.name}' 정책을 삭제하시겠어요? 저장을 완료해야 영구 삭제됩니다.`
        : `${sku} 정책을 삭제하시겠어요? 저장을 완료해야 영구 삭제됩니다.`;

      if (typeof window !== 'undefined' && !window.confirm(confirmMessage)) {
        return;
      }

      setPolicyRows((prev) =>
        prev
          .filter((row) => normalizeSku(row.sku) !== normalizedSku)
          .map(normalizePolicyRow),
      );
      manualOverrideRef.current.delete(normalizedSku);
      removeManualSku(normalizedSku);
      setStatus({ type: 'success', text: `${sku} 정책이 삭제 목록에 추가되었습니다.` });
    },
    [canInteract, productBySku, removeManualSku, setPolicyRows, setStatus],
  );

  const openAddPolicyDialog = useCallback(() => {
    if (!canTriggerPolicyCreate) {
      return;
    }
    setStatus(null);
    setAddDialogOpen(true);
  }, [canTriggerPolicyCreate]);

  const closeAddPolicyDialog = useCallback(() => {
    setAddDialogOpen(false);
  }, []);

  const handlePolicyCreate = useCallback(
    (product: Product) => {
      if (saving) {
        return;
      }

      const normalizedSku = normalizeSku(product.sku);
      setPolicyRows((prev) => {
        if (prev.some((row) => normalizeSku(row.sku) === normalizedSku)) {
          return prev;
        }

        const existingTemplate = INITIAL_POLICIES.find(
          (row) => normalizeSku(row.sku) === normalizedSku,
        );
        const draft = existingTemplate
          ? { ...existingTemplate }
          : createPolicyFromProduct(product, {
              forecast: forecastCache[normalizedSku] ?? forecastCache[product.sku],
            });

        const normalizedDraft: PolicyRow = normalizePolicyRow({
          ...draft,
          sku: normalizeSku(draft.sku),
        });
        const next = [...prev, normalizedDraft];
        next.sort((a, b) => a.sku.localeCompare(b.sku));
        return next;
      });

      manualOverrideRef.current.delete(normalizedSku);
      removeManualSku(normalizedSku);
      setStatus({ type: 'success', text: `${normalizedSku} 정책을 추가했습니다.` });
    },
    [forecastCache, removeManualSku, saving, setPolicyRows, setStatus],
  );

  const handleAutoSaveRecommendation = useCallback(
    async (
      sku: string,
      nextValues: {
        forecastDemand: number | null;
        demandStdDev: number | null;
        leadTimeDays: number | null;
        serviceLevelPercent: number | null;
      },
    ) => {
      const normalizedSku = normalizeSku(sku);
      let resolvedRow: PolicyRow | null = null;

      setPolicyRows((prev) => {
        const previous = prev.find((row) => normalizeSku(row.sku) === normalizedSku);
        const product = productBySku.get(normalizedSku);
        const baseRow: PolicyRow =
          previous ??
          normalizePolicyRow({
            sku: normalizedSku,
            name: product?.name ?? null,
            forecastDemand: null,
            demandStdDev: null,
            leadTimeDays: null,
            serviceLevelPercent: null,
            smoothingAlpha: FALLBACK_SMOOTHING_ALPHA,
            corrRho: FALLBACK_CORRELATION_RHO,
          });

        const nextRow: PolicyRow = normalizePolicyRow({
          ...baseRow,
          ...nextValues,
          sku: normalizedSku,
        });
        resolvedRow = nextRow;

        const nextList = previous
          ? prev.map((row) => (normalizeSku(row.sku) === normalizedSku ? nextRow : row))
          : [...prev, nextRow];
        nextList.sort((a, b) => a.sku.localeCompare(b.sku));
        return nextList;
      });

      if (!resolvedRow) {
        throw new Error('추천값을 적용할 정책을 찾지 못했습니다.');
      }

      manualOverrideRef.current.add(normalizedSku);

      try {
        await upsertPolicy(resolvedRow);
        if (resolvedRow) {
          addManualSku(resolvedRow.sku);
        }
        setStatus({ type: 'success', text: `${resolvedRow.sku} 정책을 자동 저장했습니다.` });
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : '추천값을 자동 저장하지 못했습니다. 다시 시도해 주세요.';
        setStatus({ type: 'error', text: message });
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(message);
      }
    },
    [addManualSku, productBySku, setPolicyRows, setStatus],
  );

  const handleSavePolicies = useCallback(async () => {
    if (saving || !canInteract) {
      return;
    }

    setSaving(true);
    setStatus(null);
    const normalizedRows = policyRows.map(normalizePolicyRow);
    const sortedRows = [...normalizedRows].sort((a, b) => a.sku.localeCompare(b.sku));
    const missingProductSkus =
      ready && productBySku.size > 0
        ? sortedRows.filter((row) => !productBySku.has(row.sku)).map((row) => row.sku)
        : [];

    writePolicyDraftBackup(sortedRows);

    setPolicyRows(sortedRows);

    try {
      await savePolicies(sortedRows);
      try {
        const refreshed = await fetchPolicies();
        const sorted = [...refreshed]
          .map((row) =>
            normalizePolicyRow({
              ...row,
              sku: normalizeSku(row.sku),
            }),
          )
          .sort((a, b) => a.sku.localeCompare(b.sku));

        let resolvedRows: PolicyRow[] | null = null;
        setPolicyRows((prev) => {
          if (sorted.length === 0) {
            resolvedRows = prev;
            return prev;
          }

          const remoteMap = new Map(sorted.map((row) => [normalizeSku(row.sku), row]));
          const manualRows = prev.filter(
            (row) => !remoteMap.has(normalizeSku(row.sku)),
          );
          if (manualRows.length === 0) {
            resolvedRows = sorted;
            return sorted;
          }

          const merged = [
            ...sorted,
            ...manualRows.map((row) =>
              normalizePolicyRow({
                ...row,
                sku: normalizeSku(row.sku),
              }),
            ),
          ];
          merged.sort((a, b) => a.sku.localeCompare(b.sku));
          resolvedRows = merged;
          return merged;
        });

      } catch {
      }
      setStatus({
        type: 'success',
        text: !ready
          ? 'Policies saved. Product data is still loading; the table will refresh once products finish loading.'
          : missingProductSkus.length > 0
              ? ('Policies saved. ' + missingProductSkus.length.toLocaleString() + ' policies reference products that are not in the current catalog. Review those entries before finalizing.')
              : 'Policies saved.',
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : '정책 저장에 실패했습니다. 다시 시도해 주세요.';
      setStatus({ type: 'error', text: message });
    } finally {
      setSaving(false);
    }
  }, [canInteract, onPersistedSkusChange, policyRows, productBySku, ready, saving]);

  return (
    <div className="space-y-6 p-6">
      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">예측기준 정책</h2>
            <p className="mt-1 text-sm text-slate-500">
              총 {policyRows.length.toLocaleString()}개 SKU 정책을 관리합니다.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:w-96">
            <div className="flex gap-2">
              <div className="flex-1">
                <label htmlFor="policy-search" className="sr-only">
                  SKU 또는 품명 검색
                </label>
                <input
                  id="policy-search"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  placeholder="SKU, 품명, 사유 검색"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <button
                type="button"
                className="rounded-xl bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                onClick={openAddPolicyDialog}
                disabled={!canTriggerPolicyCreate}
              >
                + 정책 추가
              </button>
            </div>
            {showRefreshing && (
              <p className="text-xs text-slate-400">정책 데이터를 새로고치는 중입니다...</p>
            )}
            {ready && allProducts.length === 0 && (
              <p className="text-xs text-slate-500">
                표시할 품목 정보를 불러오지 못했습니다. 품목 관리 데이터를 확인한 후 다시 시도해 주세요.
              </p>
            )}
            {ready && allProducts.length > 0 && !canAddPolicy && (
              <p className="text-xs text-slate-500">
                모든 품목에 정책이 등록되어 있습니다. 정책을 수정해 보세요.
              </p>
            )}
          </div>
        </div>

        {showInitialLoading && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            정책을 불러오는 중입니다...
          </div>
        )}

        {loadError && !showInitialLoading && (
          <div className="mt-4 flex items-start justify-between gap-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <span>{loadError}</span>
            {onReload && (
              <button
                type="button"
                className="rounded-lg border border-rose-200 px-3 py-1 text-xs font-medium text-rose-700 transition hover:border-rose-300 hover:bg-rose-100"
                onClick={onReload}
                disabled={loading}
              >
                다시 시도
              </button>
            )}
          </div>
        )}

        {status && (
          <div
            className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
              status.type === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-rose-200 bg-rose-50 text-rose-700'
            }`}
          >
            {status.text}
          </div>
        )}

        <div className="mt-6 overflow-auto rounded-2xl border border-slate-200">
          <table className="min-w-full text-sm" aria-label="정책 목록">
            <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">품명</th>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2 text-right">예측 수요량 (EA/일)</th>
                <th className="px-3 py-2 text-right">수요 표준편차 (σ)</th>
                <th className="px-3 py-2 text-right">리드타임 (L, 일)</th>
                <th className="px-3 py-2 text-right">서비스 수준 (%)</th>
                <th className="px-3 py-2 text-right">수정</th>
              </tr>
            </thead>
            <tbody>
              {registeredRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    {productBySku.size === 0
                      ? '상품 데이터를 불러오는 중입니다. 상품관리에 등록된 품목만 표시됩니다.'
                      : '조건에 맞는 정책이 없습니다.'}
                  </td>
                </tr>
              ) : (
                registeredRows.map((row) => {
                  const normalizedSku = normalizeSku(row.sku);
                  const product = productBySku.get(normalizedSku);

                  if (!product) {
                    return null;
                  }

                  return (
                    <tr key={row.sku} className="border-b border-slate-100 last:border-transparent">
                      <td className="px-3 py-3 align-top">
                        <div className="font-semibold text-slate-900">{product.name}</div>
                        <div className="text-[11px] text-slate-500">
                          {product.category ?? '카테고리 없음'} · {product.subCategory ?? '세부 없음'}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top font-mono text-xs text-slate-500">{row.sku}</td>
                      <td className="px-3 py-3 align-top text-right">{formatNumber(row.forecastDemand)}</td>
                      <td className="px-3 py-3 align-top text-right">{formatNumber(row.demandStdDev)}</td>
                      <td className="px-3 py-3 align-top text-right">{formatNumber(row.leadTimeDays)}</td>
                      <td className="px-3 py-3 align-top text-right">
                        <div className="flex items-center justify-end gap-2">
                          <label htmlFor={`service-level-${row.sku}`} className="sr-only">
                            {row.sku} 서비스 수준
                          </label>
                          <select
                            id={`service-level-${row.sku}`}
                            aria-label={`${row.sku} 서비스 수준`}
                            className="w-28 rounded-lg border border-slate-200 px-2 py-1 text-right text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                            value={
                              row.serviceLevelPercent != null ? row.serviceLevelPercent.toString() : ''
                            }
                            disabled={!canInteract}
                            onChange={(event) => handleServiceLevelChange(row.sku, event.target.value)}
                          >
                            {row.serviceLevelPercent == null && <option value="">선택</option>}
                            {SERVICE_LEVEL_PRESETS.map((preset) => (
                              <option key={preset} value={preset.toString()}>
                                {Number.isInteger(preset) ? preset.toFixed(0) : preset.toFixed(1)}%
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="flex justify-end gap-1 text-xs">
                          <button
                            type="button"
                            className="inline-flex items-center justify-center rounded-lg border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
                            onClick={() => handleEditPolicy(row.sku)}
                            disabled={!canInteract || saving}
                          >
                            수정
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center justify-center rounded-lg border border-rose-200 px-3 py-1 text-xs font-medium text-rose-600 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700"
                            onClick={() => handleDeletePolicy(row.sku)}
                            disabled={!canInteract || saving}
                          >
                            삭제
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-6 flex justify-end border-t border-slate-100 pt-4">
          <button
            type="button"
            className="mr-2 inline-flex items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-600 disabled:cursor-not-allowed disabled:border-slate-100 disabled:text-slate-400"
            onClick={openBulkApplyDialog}
            disabled={saving || !canInteract || bulkApplying}
          >
            전체 추천값 일괄 적용
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
            onClick={handleSavePolicies}
            disabled={saving || !canInteract}
          >
            {saving ? '저장 중...' : '정책 저장'}
          </button>
        </div>
      </Card>

      <PolicyCreateDialog
        open={addDialogOpen}
        onClose={closeAddPolicyDialog}
        products={allProducts}
        existingSkus={existingSkuSet}
        onSubmit={handlePolicyCreate}
      />
      <BulkApplyDialog
        open={bulkDialogOpen}
        options={bulkOptions}
        targetCount={bulkTargetCount}
        targetContext={bulkTargetContext}
        applying={bulkApplying}
        progress={bulkProgress}
        summary={bulkSummary}
        onClose={closeBulkApplyDialog}
        onConfirm={handleBulkApplyConfirm}
        onOptionChange={handleBulkOptionChange}
        disabled={!canInteract}
      />
      {editOpen && editSku && (
        <PolicyEditDialog
          open={editOpen}
          sku={editSku}
          productName={productBySku.get(normalizeSku(editSku))?.name}
          value={(() => {
            const row = policyRows.find((r) => normalizeSku(r.sku) === normalizeSku(editSku))!;
            return {
              forecastDemand: row.forecastDemand ?? null,
              demandStdDev: row.demandStdDev ?? null,
              leadTimeDays: row.leadTimeDays ?? null,
              serviceLevelPercent: row.serviceLevelPercent ?? null,
            };
          })()}
          onClose={() => {
            setEditOpen(false);
            setEditSku(null);
          }}
          onSubmit={(next) => {
            if (!editSku) return;
            setPolicyRows((prev) =>
              prev.map((row) =>
                row.sku === editSku
                  ? {
                      ...row,
                      forecastDemand: next.forecastDemand,
                      demandStdDev: next.demandStdDev,
                      leadTimeDays: next.leadTimeDays,
                      serviceLevelPercent: next.serviceLevelPercent ?? row.serviceLevelPercent,
                      smoothingAlpha: FALLBACK_SMOOTHING_ALPHA,
                      corrRho: FALLBACK_CORRELATION_RHO,
                    }
                  : row,
              ),
            );
            markManualOverride(editSku);
            addManualSku(editSku);
            setStatus({ type: 'success', text: `${editSku} 정책을 수정했습니다.` });
            setEditOpen(false);
            setEditSku(null);
          }}
          onRecommend={handleForecastRecommendation}
          onApplyEwma={handlePolicyEwma}
          onAutoSave={(next) => handleAutoSaveRecommendation(editSku, next)}
        />
      )}
    </div>
  );
};

const DeepflowDashboard: React.FC = () => {
  const outletContext = useOutletContext<SmartWarehouseOutletContext>();
  const active = outletContext?.active ?? DEFAULT_DASHBOARD_TAB;
  const mountedRef = useRef(true);
  const initialPolicyRows = useMemo(() => readPolicyDraftBackup(), []);
  const [warehousePanelRefreshToken, setWarehousePanelRefreshToken] = useState(0);
  const requestWarehousePanelReload = useCallback(
    () => setWarehousePanelRefreshToken((value) => value + 1),
    [],
  );
  const [skus, setSkus] = useState<Product[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Product | null>(null);
  const selectedRef = useRef<Product | null>(null);
  const [promoExclude, setPromoExclude] = useState(true);
  const [policyRows, setPolicyRows] = useState<PolicyRow[]>(initialPolicyRows);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyLoadError, setPolicyLoadError] = useState<string | null>(null);
  const [policyReady, setPolicyReady] = useState(false);
  const [persistedPolicySkus, setPersistedPolicySkus] = useState<string[]>(() =>
    readManualSkuBackup(),
  );
  const [forecastState, setForecastState] = useState<Record<number, ForecastStateEntry>>({});
  const [productDrawer, setProductDrawer] = useState<ProductDrawerState | null>(null);
  const [productQuery, setProductQuery] = useState('');
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [productActionError, setProductActionError] = useState<string | null>(null);
  const [productsVersion, setProductsVersion] = useState(0);
  const [catalogReady, setCatalogReady] = useState(false);
  const [productSaving, setProductSaving] = useState(false);
  const [productDeleting, setProductDeleting] = useState(false);
  const [csvDialogOpen, setCsvDialogOpen] = useState(false);
  const [csvDownloadPending, setCsvDownloadPending] = useState(false);
  const [csvStatus, setCsvStatus] = useState<CsvStatusMessage | null>(null);
  const autoDraftedSkuRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadPolicies = useCallback(async () => {
    if (!mountedRef.current) {
      return;
    }

    setPolicyLoading(true);
    setPolicyLoadError(null);

    try {
      const remotePolicies = await fetchPolicies();
      if (!mountedRef.current) {
        return;
      }

      const normalizedRemote = remotePolicies.map((row) =>
        normalizePolicyRow({
          ...row,
          sku: normalizeSku(row.sku),
        }),
      );
      const sorted = [...normalizedRemote].sort((a, b) => a.sku.localeCompare(b.sku));
      const remoteSkuSet = new Set(sorted.map((row) => row.sku));
      const backupRows = readPolicyDraftBackup().map((row) =>
        normalizePolicyRow({
          ...row,
          sku: normalizeSku(row.sku),
        }),
      );
      const backupAdditional = backupRows.filter((row) => !remoteSkuSet.has(row.sku));
      const baseRows = sorted.length > 0 ? [...sorted, ...backupAdditional] : [...backupRows];
      if (baseRows.length > 1) {
        baseRows.sort((a, b) => a.sku.localeCompare(b.sku));
      }

      setPolicyRows((prev) => {
        if (prev.length === 0) {
          return baseRows;
        }

        if (baseRows.length === 0) {
          return prev.map(normalizePolicyRow);
        }

        const manualRows = prev.filter((row) => !remoteSkuSet.has(normalizeSku(row.sku)));
        if (manualRows.length === 0) {
          return baseRows;
        }

        const merged = [
          ...baseRows,
          ...manualRows.map((row) =>
            normalizePolicyRow({
              ...row,
              sku: normalizeSku(row.sku),
            }),
          ),
        ];
        const unique = new Map<string, PolicyRow>();
        merged.forEach((row) => {
          unique.set(
            normalizeSku(row.sku),
            normalizePolicyRow({
              ...row,
              sku: normalizeSku(row.sku),
            }),
          );
        });
        const next = Array.from(unique.values());
        next.sort((a, b) => a.sku.localeCompare(b.sku));
        return next;
      });
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      const message =
        error instanceof Error && error.message ? error.message : '정책을 불러오지 못했습니다.';
      setPolicyLoadError(message);
      const backupRows = readPolicyDraftBackup().map((row) =>
        normalizePolicyRow({
          ...row,
          sku: normalizeSku(row.sku),
        }),
      );
      if (backupRows.length > 0) {
        setPolicyRows((prev) => (prev.length === 0 ? backupRows : prev.map(normalizePolicyRow)));
      }
    } finally {
      if (mountedRef.current) {
        setPolicyLoading(false);
        setPolicyReady(true);
      }
    }
  }, [setPolicyRows, setPolicyLoadError, setPolicyLoading, setPolicyReady]);

  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  useEffect(() => {
    if (!policyReady) {
      return;
    }
    writePolicyDraftBackup(policyRows);
  }, [policyReady, policyRows]);

  useEffect(() => {
    writeManualSkuBackup(persistedPolicySkus);
  }, [persistedPolicySkus]);

  const handleReloadPolicies = useCallback(() => {
    if (policyLoading) {
      return;
    }
    void loadPolicies();
  }, [loadPolicies, policyLoading]);

  const triggerProductsReload = useCallback(() => {
    setProductsError(null);
    setProductsVersion((value) => value + 1);
  }, [setProductsError]);

  const refreshSelectedProduct = useCallback(
    async (sku: string) => {
      try {
        const items = await ProductService.fetchProducts(sku);
        if (!mountedRef.current) {
          return;
        }
        const updated = items.find((item) => item.sku === sku) ?? null;
        if (updated) {
          setSelected((prev) => (prev && prev.sku === sku ? updated : prev));
        }
      } catch (error) {
        // 선택된 품목 새로고침 실패는 무시 (목록 새로고침으로 복구됨)
      }
    },
    [setSelected],
  );

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    const unsubscribe = subscribeInventoryRefresh((event) => {
      triggerProductsReload();

      const current = selectedRef.current;
      if (!current?.sku) {
        return;
      }

      const movements = event.detail?.movements ?? [];
      if (movements.length === 0) {
        void refreshSelectedProduct(current.sku);
        return;
      }

      const shouldRefresh = movements.some((movement) => {
        if (movement.product?.sku && movement.product.sku === current.sku) {
          return true;
        }
        if (
          typeof movement.productId === 'number' &&
          Number.isFinite(current.legacyProductId) &&
          movement.productId === current.legacyProductId
        ) {
          return true;
        }
        return false;
      });

      if (shouldRefresh) {
        void refreshSelectedProduct(current.sku);
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [refreshSelectedProduct, triggerProductsReload]);

  const handleCsvUploadOpen = useCallback(() => {
    setCsvStatus(null);
    setCsvDialogOpen(true);
  }, []);

  const handleCsvDialogClose = useCallback(() => {
    setCsvDialogOpen(false);
  }, []);

  const handleCsvDownload = useCallback(async () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      setCsvStatus({ kind: 'error', message: '브라우저 환경에서만 다운로드를 지원합니다.' });
      return;
    }
    setCsvDownloadPending(true);
    setCsvStatus(null);
    try {
      const blob = await downloadTemplate('products');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'products-template.csv';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setCsvStatus({ kind: 'success', message: 'CSV 템플릿을 다운로드했습니다.' });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'CSV 템플릿을 다운로드하지 못했습니다.';
      setCsvStatus({ kind: 'error', message });
    } finally {
      setCsvDownloadPending(false);
    }
  }, []);

  const handleCsvCompleted = useCallback(() => {
    // Reload products and policies so auto-created policy drafts from CSV appear immediately
    triggerProductsReload();
    void loadPolicies();
    setCsvStatus({ kind: 'success', message: 'CSV 업로드 작업이 완료되어 목록을 갱신했습니다.' });
  }, [triggerProductsReload, loadPolicies]);

  const forecastProductIds = useMemo(() => {
    const ids = new Set<number>();
    skus.forEach((row) => {
      if (Number.isFinite(row.legacyProductId) && row.legacyProductId > 0) {
        ids.add(row.legacyProductId);
      }
    });
    return Array.from(ids).sort((a, b) => a - b);
  }, [skus]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setProductsLoading(true);
      try {
        const items = await ProductService.fetchProducts(productQuery);
        if (cancelled) {
          return;
        }
        setSkus(items);
        setProductsError(null);
        if (!productQuery.trim()) {
          setAllProducts(items);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof Error && error.message
            ? error.message
            : '품목 목록을 불러오지 못했습니다.';
        setProductsError(message);
        setSkus([]);
      } finally {
        if (!cancelled) {
          setProductsLoading(false);
          setCatalogReady(true);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [productQuery, productsVersion]);

  useEffect(() => {
    if (!productQuery.trim()) {
      return;
    }

    let cancelled = false;

    const run = async () => {
      try {
        const items = await ProductService.fetchProducts();
        if (cancelled) {
          return;
        }
        setAllProducts(items);
      } catch {
        if (!cancelled) {
          setAllProducts((prev) => prev);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [productQuery, productsVersion]);

  useEffect(() => {
    if (!policyReady || productsLoading) {
      return;
    }

    const allowedSkuSet = new Set(allProducts.map((product) => normalizeSku(product.sku)));
    // Skip reconciliation while the catalog has not loaded; otherwise transient empty fetches clear saved policies.
    if (allowedSkuSet.size === 0) {
      return;
    }

    setPersistedPolicySkus((prev) => {
      if (prev.length === 0) {
        return prev;
      }

      const next = prev.filter((sku) => allowedSkuSet.has(normalizeSku(sku)));
      return next.length === prev.length ? prev : next;
    });
  }, [allProducts, policyReady, productsLoading, setPersistedPolicySkus]);

  useEffect(() => {
    if (!selected && skus.length > 0) {
      setSelected(skus[0]);
      return;
    }

    if (selected) {
      const updated = skus.find((item) => item.sku === selected.sku);
      if (!updated && skus.length > 0) {
        setSelected(skus[0]);
      } else if (updated && updated !== selected) {
        setSelected(updated);
      }
    }
  }, [skus, selected]);

  useEffect(() => {
    const pending = forecastProductIds.filter((id) => id > 0 && !forecastState[id]);
    if (pending.length === 0) {
      return;
    }

    let cancelled = false;

    setForecastState((prev) => {
      const next = { ...prev };
      pending.forEach((id) => {
        if (!next[id]) {
          next[id] = { status: 'loading' };
        }
      });
      return next;
    });

    const run = async () => {
      const results = await Promise.all(
        pending.map(async (productId) => {
          try {
            const data = await fetchForecast(productId);
            return { productId, data } as const;
          } catch (error) {
            const message =
              error instanceof Error && error.message
                ? error.message
                : '수요예측을 불러오지 못했습니다.';
            return { productId, error: message } as const;
          }
        }),
      );

      if (cancelled) {
        return;
      }

      setForecastState((prev) => {
        const next = { ...prev };
        results.forEach((result) => {
          if ('data' in result && result.data) {
            next[result.productId] = { status: 'ready', data: result.data };
          } else if ('error' in result && result.error) {
            next[result.productId] = { status: 'error', error: result.error };
          }
        });
        return next;
      });
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [forecastProductIds, forecastState]);

  const kpis = useMemo<KpiSummary>(() => {
    if (skus.length === 0) {
      return { opening: 0, avgDOS: 0, turns: 8.4, serviceLevel: 0.95 };
    }

    const opening = skus.reduce((sum, item) => sum + item.onHand, 0);
    const etaSummary = skus.reduce(
      (acc, item) => {
        const eta = calculateEtaDays(item);
        if (eta !== null) {
          acc.sum += eta;
          acc.count += 1;
        }
        return acc;
      },
      { sum: 0, count: 0 },
    );
    const avgDOS = etaSummary.count > 0 ? Math.round(etaSummary.sum / etaSummary.count) : 0;
    const serviceLevel = calculateServiceLevelPercent(skus) / 100;

    return {
      opening,
      avgDOS,
      turns: 8.4,
      serviceLevel,
    };
  }, [skus]);

  const riskSummary = useMemo<RiskSummaryEntry[]>(() => {
        const totals: Record<InventoryRisk, number> = { [RISK_NORMAL]: 0, [RISK_STOCKOUT]: 0, [RISK_OVERSTOCK]: 0 };
    skus.forEach((row) => {
      totals[row.risk] += 1;
    });
    const totalSkus = skus.length;
    return RISK_ORDER.map((risk) => ({
      risk,
      count: totals[risk],
      ratio: totalSkus > 0 ? Math.round((totals[risk] / totalSkus) * 100) : 0,
    }));
  }, [skus]);

  const forecastCache = useMemo<Record<string, ForecastResponse>>(() => {
    const map: Record<string, ForecastResponse> = {};
    (Object.values(forecastState) as ForecastStateEntry[]).forEach((entry) => {
      if (entry?.status === 'ready' && entry.data) {
        const key = entry.data.product.sku;
        const normalized = normalizeSku(key);
        map[key] = entry.data;
        map[normalized] = entry.data;
      }
    });
    return map;
  }, [forecastState]);

  useEffect(() => {
    if (!policyReady || !catalogReady) {
      return;
    }

    const validSkuSet = new Set(allProducts.map((product) => normalizeSku(product.sku)));

    let nextRows = policyRows;
    let mutated = false;

    if (policyRows.length > 0) {
      const filtered = policyRows.filter((row) => validSkuSet.has(normalizeSku(row.sku)));
      if (filtered.length !== policyRows.length) {
        nextRows = filtered;
        mutated = true;
      }
    }

    const existingSkuSet = new Set(nextRows.map((row) => normalizeSku(row.sku)));
    const drafts: PolicyRow[] = [];

    allProducts.forEach((product) => {
      const normalizedSkuValue = normalizeSku(product.sku);
      if (existingSkuSet.has(normalizedSkuValue) || autoDraftedSkuRef.current.has(normalizedSkuValue)) {
        return;
      }

      const forecast = forecastCache[product.sku] ?? forecastCache[normalizedSkuValue];
      const draft = normalizePolicyRow(
        createPolicyFromProduct(product, {
          forecast,
        }),
      );

      drafts.push(draft);
      autoDraftedSkuRef.current.add(normalizedSkuValue);
    });

    if (drafts.length > 0) {
      nextRows = [...nextRows, ...drafts];
      nextRows.sort((a, b) => a.sku.localeCompare(b.sku));
      mutated = true;
    }

    if (!mutated) {
      return;
    }

      const normalizedRows = nextRows.map((row) =>
        normalizePolicyRow({
          ...row,
          sku: normalizeSku(row.sku),
        }),
      );

      const distinctRows = Array.from(
        new Map(normalizedRows.map((row) => [normalizeSku(row.sku), row])).values(),
      ).sort((a, b) => a.sku.localeCompare(b.sku));

      setPolicyRows(distinctRows);

      void (async () => {
        try {
          await savePolicies(distinctRows.map(normalizePolicyRow));
          setPolicyLoadError(null);
        } catch (error) {
          console.error('[deepflow] policy auto-draft sync failed', error);
          setPolicyLoadError('정책 자동 생성 결과를 저장하지 못했습니다. 다시 시도해 주세요.');
        }
      })();
    }, [allProducts, catalogReady, forecastCache, policyReady, policyRows, setPolicyLoadError, setPolicyRows]);

  const forecastStatusBySku = useMemo<Record<string, ForecastStateEntry>>(() => {
    const map: Record<string, ForecastStateEntry> = {};
    skus.forEach((row) => {
      const normalized = normalizeSku(row.sku);
      if (row.legacyProductId > 0) {
        const status = forecastState[row.legacyProductId] ?? { status: 'idle' };
        map[row.sku] = status;
        map[normalized] = status;
      } else {
        map[row.sku] = { status: 'idle' };
        map[normalized] = { status: 'idle' };
      }
    });
    return map;
  }, [forecastState, skus]);

  const policyBySku = useMemo(() => {
    const map = new Map<string, PolicyRow>();
    policyRows.forEach((entry) => {
      const normalized = normalizeSku(entry.sku);
      map.set(normalized, entry);
      if (normalized !== entry.sku) {
        map.set(entry.sku, entry);
      }
    });
    return map;
  }, [policyRows]);

  const openProduct = useCallback(
    (row: Product, mode: DrawerMode = 'edit') => {
      setProductActionError(null);
      setProductDrawer({ mode, row: { ...row }, originalSku: mode === 'edit' ? row.sku : undefined });
    },
    [setProductActionError],
  );

  const closeProduct = useCallback(() => {
    setProductActionError(null);
    setProductDrawer(null);
  }, [setProductActionError]);

  const handleProductDelete = useCallback(
    async (row: Product) => {
      if (!row?.sku) {
        return;
      }

      if (typeof window !== 'undefined') {
        const confirmed = window.confirm(`'${row.name || row.sku}' 품목을 삭제하시겠습니까?`);
        if (!confirmed) {
          return;
        }
      }

      try {
        await ProductService.deleteProduct(row.sku);
        const normalizedSku = normalizeSku(row.sku);
        setSkus((prev) => prev.filter((item) => normalizeSku(item.sku) !== normalizedSku));
        let nextPolicyDrafts: PolicyRow[] = [];
        setPolicyRows((prev) => {
          const filtered = prev
            .filter((item) => normalizeSku(item.sku) !== normalizedSku)
            .map((item) =>
              normalizePolicyRow({
                ...item,
                sku: normalizeSku(item.sku),
              }),
            );
          nextPolicyDrafts = filtered;
          return filtered;
        });
        if (nextPolicyDrafts.length === policyRows.length) {
          nextPolicyDrafts = policyRows
            .filter((item) => normalizeSku(item.sku) !== normalizedSku)
            .map((item) =>
              normalizePolicyRow({
                ...item,
                sku: normalizeSku(item.sku),
              }),
            );
        }
        setSelected((prev) => (prev && prev.sku === row.sku ? null : prev));
        setForecastState((prev) => {
          if (!row.legacyProductId || !(row.legacyProductId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[row.legacyProductId];
          return next;
        });
        setProductDrawer((current) => {
          if (!current) {
            return current;
          }
          const targetSku = current.originalSku ?? current.row.sku;
          if (normalizeSku(targetSku) === normalizedSku) {
            return null;
          }
          return current;
        });
        try {
          await savePolicies(nextPolicyDrafts);
          setPersistedPolicySkus((prev) =>
            prev.filter((sku) => normalizeSku(sku) !== normalizedSku),
          );
          setPolicyLoadError(null);
        } catch (error) {
          console.error('[deepflow] policy sync failed after product deletion', error);
          setPolicyLoadError('정책 자동 정리에 실패했습니다. 정책 저장을 다시 시도해 주세요.');
        }
        triggerProductsReload();
      } catch (error) {
        const message =
          error instanceof Error && error.message ? error.message : '품목 삭제에 실패했습니다.';
        setProductsError(message);
      }
    },
    [
      setSkus,
      setPolicyRows,
      policyRows,
      setSelected,
      setForecastState,
      setProductDrawer,
      savePolicies,
      setPersistedPolicySkus,
      setPolicyLoadError,
      triggerProductsReload,
      setProductsError,
    ],
  );

  const saveProduct = useCallback(async () => {
    if (!productDrawer || productSaving) {
      return;
    }

    const { row, mode, originalSku } = productDrawer;
    if (!row.sku.trim() || !row.name.trim()) {
      setProductActionError('SKU와 품명은 비워둘 수 없습니다.');
      return;
    }

    const validationError = validateProductDraft(row);
    if (validationError) {
      setProductActionError(validationError);
      return;
    }

    const normalizedSku = row.sku.trim();
    const duplicateSkuExists = skus.some(
      (item) => item.sku === normalizedSku && (mode === 'new' || item.sku !== originalSku),
    );
    if (duplicateSkuExists) {
      setProductActionError('이미 존재하는 SKU입니다. 다른 값을 사용해 주세요.');
      return;
    }

    const normalized = normalizeProduct(row);
    setProductSaving(true);
    setProductActionError(null);
    try {
      const saved =
        mode === 'new'
          ? await ProductService.createProduct(normalized)
          : await ProductService.updateProduct(originalSku ?? row.sku, normalized);
      const normalizedTargetSku = normalizeSku(originalSku ?? row.sku);
      const normalizedSavedSku = normalizeSku(saved.sku);

      setPolicyRows((prev) => {
        const targetSku = originalSku ?? row.sku;
        const index = prev.findIndex((item) => item.sku === targetSku);
        if (index >= 0) {
          const next = [...prev];
          const draft = createPolicyFromProduct(saved, {
            forecast: forecastCache[saved.sku],
            serviceLevelPercent: next[index].serviceLevelPercent,
          });
          next[index] = normalizePolicyRow({
            ...next[index],
            sku: saved.sku,
            name: saved.name?.trim() || draft.name || next[index].name || null,
            forecastDemand: draft.forecastDemand ?? next[index].forecastDemand,
            demandStdDev: draft.demandStdDev ?? next[index].demandStdDev,
            leadTimeDays: draft.leadTimeDays ?? next[index].leadTimeDays,
          });
          return next;
        }

        const draft = normalizePolicyRow(
          createPolicyFromProduct(saved, { forecast: forecastCache[saved.sku] }),
        );
        const next = [...prev, draft];
        next.sort((a, b) => a.sku.localeCompare(b.sku));
        return next;
      });

      const applySavedProduct = (list: Product[]): Product[] => {
        let replaced = false;
        const next = list.map((item) => {
          const normalizedItemSku = normalizeSku(item.sku);
          if (
            normalizedItemSku === normalizedTargetSku ||
            normalizedItemSku === normalizedSavedSku
          ) {
            replaced = true;
            return saved;
          }
          return item;
        });
        if (replaced) {
          return next;
        }
        return [...next, saved];
      };

      setSkus(applySavedProduct);
      setAllProducts(applySavedProduct);
      setSelected(saved);
      setProductActionError(null);
      closeProduct();
      triggerProductsReload();
    } catch (error) {
      const fallback =
        error instanceof Error && error.message ? error.message : '품목 저장에 실패했습니다.';
      if (isHttpError(error)) {
        const detail = extractFirstDetail(error.payload);
        setProductActionError(detail ?? fallback);
      } else {
        setProductActionError(fallback);
      }
    } finally {
      setProductSaving(false);
    }
  }, [
    closeProduct,
    forecastCache,
    productDrawer,
    productSaving,
    setAllProducts,
    setPolicyRows,
    setSelected,
    setSkus,
    skus,
    triggerProductsReload,
  ]);

  const deleteProduct = useCallback(async () => {
    if (!productDrawer || productDrawer.mode !== 'edit' || productDeleting) {
      return;
    }

    const targetSku = productDrawer.originalSku ?? productDrawer.row.sku;
    if (!targetSku) {
      return;
    }

    setProductDeleting(true);
    setProductActionError(null);
    try {
      await ProductService.deleteProduct(targetSku);
      setPolicyRows((prev) => prev.filter((entry) => entry.sku !== targetSku));
      setProductActionError(null);
      setSelected((prev) => (prev && prev.sku === targetSku ? null : prev));
      if (productDrawer.row.legacyProductId) {
        setForecastState((prev) => {
          const next = { ...prev };
          delete next[productDrawer.row.legacyProductId];
          return next;
        });
      }
      closeProduct();
      triggerProductsReload();
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : '품목 삭제에 실패했습니다.';
      setProductActionError(message);
    } finally {
      setProductDeleting(false);
    }
  }, [closeProduct, productDeleting, productDrawer, triggerProductsReload]);


  return (
    <>
              {active === 'inventory' && (
                <InventoryOverviewPage
                  skus={skus}
                  selected={selected}
                  setSelected={setSelected}
                  kpis={kpis}
                  riskSummary={riskSummary}
                  forecastCache={forecastCache}
                  forecastStatusBySku={forecastStatusBySku}
                  policies={policyRows}
                />
              )}

              {active === 'forecast' && (
                <ForecastPage
                  skus={skus}
                  promoExclude={promoExclude}
                  setPromoExclude={setPromoExclude}
                  forecastCache={forecastCache}
                  forecastStatusBySku={forecastStatusBySku}
                  policyBySku={policyBySku}
                />
              )}

              {active === 'products' && (
                <ProductsPage
                  skus={skus}
                  query={productQuery}
                  onQueryChange={setProductQuery}
                  loading={productsLoading}
                  error={productsError}
                  onRetry={triggerProductsReload}
                  onEdit={(row) => openProduct(row, 'edit')}
                  onDelete={handleProductDelete}
                  onNew={() => openProduct(createEmptyProduct(), 'new')}
                  onCsvUpload={handleCsvUploadOpen}
                  onCsvDownload={handleCsvDownload}
                  csvDownloading={csvDownloadPending}
                  csvStatus={csvStatus}
                />
              )}

              {active === 'policies' && (
                <PoliciesPage
                  skus={skus}
                  allProducts={allProducts}
                  policyRows={policyRows}
                  setPolicyRows={setPolicyRows}
                  forecastCache={forecastCache}
                  loading={policyLoading}
                  loadError={policyLoadError}
                  onReload={handleReloadPolicies}
                  persistedManualSkus={persistedPolicySkus}
                  ready={policyReady}
                  onPersistedSkusChange={setPersistedPolicySkus}
                />
              )}

              {active === 'policyOps' && <PolicyOpsDashboard products={allProducts} />}

              {active === 'purchase' && <PurchasePage />}
              {active === 'sales' && <SalesPage />}

              {active === 'warehouses' && (
                <WarehouseManagementPanel
                  refreshToken={warehousePanelRefreshToken}
                  onRequestReload={requestWarehousePanelReload}
                />
              )}

              {active === 'categories' && <CategoryManagementPanel />}

              {active === 'partners' && <PartnerManagementPanel />}

              <ProductCsvUploadDialog
                open={csvDialogOpen}
                onClose={handleCsvDialogClose}
                onCompleted={handleCsvCompleted}
              />

              {productDrawer && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-8"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="deepflow-product-modal-title"
                  onClick={closeProduct}
                >
                  <div
                    className="w-full max-w-3xl overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-slate-200"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="flex items-start justify-between border-b border-slate-100 px-6 py-4">
                      <div>
                        <h3 id="deepflow-product-modal-title" className="text-lg font-semibold text-slate-900">
                          {productDrawer.mode === 'new' ? '품목 등록' : '품목 수정'}
                        </h3>
                        <p className="mt-1 text-xs text-slate-500">
                          SKU {productDrawer.originalSku?.trim() || productDrawer.row.sku.trim() || '신규'}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                        onClick={closeProduct}
                        aria-label="품목 편집 닫기"
                      >
                        닫기
                      </button>
                    </div>
                    <div className="max-h-[70vh] overflow-y-auto px-6 py-4">
                      <ProductForm
                        row={productDrawer.row}
                        onChange={(row) => setProductDrawer({ ...productDrawer, row })}
                        existingSkus={skus
                          .map((item) => item.sku)
                          .filter((sku) => sku !== (productDrawer.originalSku ?? ''))}
                      />
                      {productActionError && (
                        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                          {productActionError}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 border-t border-slate-100 px-6 py-4 text-sm">
                      <button
                        type="button"
                        className="rounded-xl border border-slate-200 px-3 py-2 text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
                        onClick={closeProduct}
                        disabled={productSaving || productDeleting}
                      >
                        취소
                      </button>
                      {productDrawer.mode === 'edit' && (
                        <button
                          type="button"
                          className="rounded-xl border border-rose-200 px-3 py-2 text-rose-600 transition hover:bg-rose-50 disabled:opacity-60"
                          onClick={deleteProduct}
                          disabled={productSaving || productDeleting}
                        >
                          {productDeleting ? '삭제 중...' : '삭제'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="rounded-xl bg-indigo-600 px-3 py-2 font-medium text-white transition hover:bg-indigo-500 disabled:opacity-60"
                        onClick={saveProduct}
                        disabled={productSaving}
                      >
                        {productSaving ? '저장 중...' : productDrawer.mode === 'new' ? '등록' : '저장'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

    </>
  );

};

const ForecastPage: React.FC<ForecastPageProps> = ({
  skus,
  promoExclude,
  setPromoExclude,
  forecastCache,
  forecastStatusBySku,
  policyBySku,
}) => {
  const [mode, setMode] = useState<'perSku' | 'overall'>('perSku');
  const [selectedSku, setSelectedSku] = useState<string | null>(skus[0]?.sku ?? null);
  const [chartWindowMonths, setChartWindowMonths] = useState<ChartWindowMonths>(12);
  const [chartGranularity, setChartGranularity] = useState<ChartGranularity>('month');
  const [insightsState, setInsightsState] = useState<Record<string, InsightStateEntry>>({});
  const [actionPlanSubmitting, setActionPlanSubmitting] = useState(false);
  const [actionPlanApproving, setActionPlanApproving] = useState(false);

  useEffect(() => {
    if (skus.length === 0) {
      if (selectedSku !== null) {
        setSelectedSku(null);
      }
      return;
    }

    if (!selectedSku || !skus.some((row) => row.sku === selectedSku)) {
      setSelectedSku(skus[0].sku);
    }
  }, [skus, selectedSku]);

  const { seriesMap, forecastIndexMap } = useMemo(() => {
    const map: Record<string, ForecastSeriesPoint[]> = {};
    const indexMap: Record<string, number> = {};

    skus.forEach((row, idx) => {
      const forecast = forecastCache[row.sku];
      if (forecast) {
        const points = forecast.timeline.map((point) => {
          const label = formatMonthLabel(point.date);
          const fcValue =
            promoExclude && point.phase === 'forecast' && point.promo
              ? Math.round(point.forecast * 0.92)
              : Math.round(point.forecast);
          return {
            date: label,
            isoDate: point.date,
            actual: point.actual !== null ? Math.round(point.actual) : null,
            fc: fcValue,
            phase: point.phase,
            promo: point.promo ?? false,
          } satisfies ForecastSeriesPoint;
        });
        map[row.sku] = points;
        const forecastIdx = points.findIndex((point) => point.phase === 'forecast');
        indexMap[row.sku] = forecastIdx >= 0 ? forecastIdx : points.length;
      } else {
        const points = buildFallbackSeries(row, idx, promoExclude);
        map[row.sku] = points;
        const forecastIdx = points.findIndex((point) => point.phase === 'forecast');
        indexMap[row.sku] = forecastIdx >= 0 ? forecastIdx : points.length;
      }
    });

    return { seriesMap: map, forecastIndexMap: indexMap };
  }, [forecastCache, promoExclude, skus]);

  const anchorSku = useMemo(() => {
    return selectedSku ?? skus[0]?.sku ?? null;
  }, [selectedSku, skus]);

  const anchorSeries = anchorSku ? seriesMap[anchorSku] ?? [] : [];
  const anchorForecastIndex = anchorSku
    ? forecastIndexMap[anchorSku] ?? anchorSeries.length
    : anchorSeries.length;

  const forecastRange: ForecastRange | null =
    anchorForecastIndex >= 0 && anchorForecastIndex < anchorSeries.length
      ? {
          start: anchorSeries[anchorForecastIndex].date,
          end: anchorSeries[anchorSeries.length - 1].date,
        }
      : null;

  const handleRowClick = useCallback((sku: string) => {
    setSelectedSku(sku);
  }, []);

  const { chartData, visibleSeries } = useMemo<{
    chartData: Array<{
      date: string;
      isoDate: string;
      ts?: number;
      actual: number | null;
      fc: number;
      forecast: number;
      phase: 'history' | 'forecast';
      isFinal: boolean;
    }>;
    visibleSeries: ForecastSeriesPoint[];
  }>(() => {
    const toChartData = (series: ForecastSeriesPoint[]) =>
      series.map((point) => {
        const source = point.isoDate ?? point.date;
        const epoch = parseIsoToUtcEpoch(source);
        return {
          date: point.date,
          isoDate: point.isoDate,
          ts: epoch ?? undefined,
          actual: point.actual,
          fc: point.fc,
          forecast: point.fc,
          phase: point.phase,
          isFinal: point.phase !== 'forecast',
        };
      });

    const selectSeries = (sku: string | null | undefined): ForecastSeriesPoint[] =>
      sku ? seriesMap[sku] ?? [] : [];

    if (mode === 'overall') {
      const targetSku = anchorSku ?? skus[0]?.sku ?? null;
      if (!targetSku) {
        return { chartData: [], visibleSeries: [] };
      }
      const targetSeries = selectSeries(targetSku);
      const filtered = filterSeriesByMonths(targetSeries, chartWindowMonths);
      const fallbackCount = Math.max(Math.min(chartWindowMonths, targetSeries.length), Math.min(6, targetSeries.length));
      const effective =
        filtered.length > 0
          ? filtered
          : targetSeries.slice(-Math.max(fallbackCount, Math.min(6, targetSeries.length)));
      return { chartData: toChartData(effective), visibleSeries: effective };
    }

    const targetSku = selectedSku ?? anchorSku ?? skus[0]?.sku ?? null;
    if (!targetSku) {
      return { chartData: [], visibleSeries: [] };
    }

    const targetSeries = selectSeries(targetSku);
    const filtered = filterSeriesByMonths(targetSeries, chartWindowMonths);
    const fallbackCount = Math.max(Math.min(chartWindowMonths, targetSeries.length), Math.min(6, targetSeries.length));
    const effective =
      filtered.length > 0
        ? filtered
        : targetSeries.slice(-Math.max(fallbackCount, Math.min(6, targetSeries.length)));

    return { chartData: toChartData(effective), visibleSeries: effective };
  }, [anchorSku, chartWindowMonths, mode, selectedSku, seriesMap, skus]);

  const anchorForecast = anchorSku ? forecastCache[anchorSku] : undefined;
  const anchorStatus = anchorSku ? forecastStatusBySku[anchorSku] : undefined;

  const adjustedForecastRange = useMemo(
    () => adjustForecastRange(forecastRange, chartData),
    [forecastRange, chartData],
  );

  const weeklyChartData = useMemo(() => {
    if (!anchorForecast?.weeklyForecast?.timeline?.length) {
      return [];
    }

    const weeklySeries: ForecastSeriesPoint[] = anchorForecast.weeklyForecast.timeline.map((point) => ({
      date: point.weekStart,
      isoDate: point.weekStart,
      actual: Number.isFinite(point.actual ?? Number.NaN) ? Math.round(point.actual ?? 0) : null,
      fc: Math.round(point.forecast ?? 0),
      phase: point.phase,
      promo: point.promo ?? false,
    }));

    const filtered = filterSeriesByMonths(weeklySeries, chartWindowMonths);
    return filtered.map((point) => {
      const source = point.isoDate ?? point.date;
      const epoch = parseIsoToUtcEpoch(source);
      return {
        date: point.date,
        isoDate: point.isoDate,
        ts: epoch ?? undefined,
        actual: point.actual,
        fc: point.fc,
        forecast: point.fc,
        phase: point.phase,
        isFinal: point.phase !== 'forecast',
      };
    });
  }, [anchorForecast, chartWindowMonths]);

  const accuracyBadge = useMemo(() => {
    if (!anchorForecast?.timeline?.length) {
      return null;
    }
    const historyPoints = anchorForecast.timeline.filter(
      (point) => point.phase === 'history' && typeof point.actual === 'number' && Number.isFinite(point.actual),
    );
    if (historyPoints.length === 0) {
      return null;
    }

    let absErrorSum = 0;
    let actualSum = 0;
    let biasSum = 0;
    let coverageHit = 0;
    let coverageTotal = 0;

    historyPoints.forEach((point) => {
      const actual = typeof point.actual === 'number' ? point.actual : 0;
      const forecastValue = Number.isFinite(point.forecast) ? point.forecast : 0;
      absErrorSum += Math.abs(actual - forecastValue);
      actualSum += Math.abs(actual);
      biasSum += forecastValue - actual;

      if (Number.isFinite(point.lower) && Number.isFinite(point.upper)) {
        coverageTotal += 1;
        if (actual >= point.lower && actual <= point.upper) {
          coverageHit += 1;
        }
      }
    });

    if (actualSum === 0) {
      return null;
    }

    return {
      wape: (absErrorSum / actualSum) * 100,
      bias: (biasSum / actualSum) * 100,
      coverage: coverageTotal > 0 ? (coverageHit / coverageTotal) * 100 : null,
    };
  }, [anchorForecast]);
  const anchorLoading = anchorStatus?.status === 'loading';
  const anchorError =
    anchorStatus?.status === 'error'
      ? anchorStatus.error || '예측 데이터를 불러오지 못했습니다.'
      : null;
  const activeProduct = useMemo(() => {
    if (!anchorSku) {
      return null;
    }
    return skus.find((row) => row.sku === anchorSku) ?? null;
  }, [anchorSku, skus]);

  const resolvedMetrics = useMemo<ForecastMetrics | null>(() => {
    if (anchorForecast?.metrics) {
      return anchorForecast.metrics;
    }
    if (activeProduct) {
      return buildFallbackMetrics(activeProduct, anchorSeries);
    }
    return null;
  }, [anchorForecast, activeProduct, anchorSeries]);

  const resolvedExplanation = useMemo<ForecastExplanation | null>(() => {
    if (anchorForecast?.explanation) {
      return anchorForecast.explanation;
    }
    if (activeProduct && resolvedMetrics) {
      return buildFallbackExplanation(activeProduct, resolvedMetrics);
    }
    return null;
  }, [anchorForecast, activeProduct, resolvedMetrics]);

  const fallbackActionPlanItems = useMemo<ActionPlanItem[]>(() => {
    if (!activeProduct || !resolvedMetrics) {
      return [];
    }
    return buildActionPlans(activeProduct, resolvedMetrics);
  }, [activeProduct, resolvedMetrics]);

  useEffect(() => {
    if (!anchorSku || !activeProduct || !resolvedMetrics) {
      return;
    }

    const productId = activeProduct.legacyProductId;
    if (!Number.isFinite(productId) || productId <= 0) {
      return;
    }

    const normalizedSku = normalizeSku(anchorSku);
    const forecastEntry = forecastCache[anchorSku] ?? forecastCache[normalizedSku] ?? null;
    const safetyStockFromForecast = Number.isFinite(forecastEntry?.product?.safetyStock)
      ? Math.max(Math.round(forecastEntry!.product!.safetyStock ?? 0), 0)
      : safetyStock(activeProduct);
    const available = availableStock(activeProduct);

    const metricsKey = [
      normalizedSku,
      chartWindowMonths,
      promoExclude ? 'promo-off' : 'promo-on',
      resolvedMetrics.windowStart ?? '',
      resolvedMetrics.windowEnd ?? '',
      resolvedMetrics.avgDailyDemand ?? '',
      resolvedMetrics.currentTotalStock ?? '',
      resolvedMetrics.reorderPoint ?? '',
      resolvedMetrics.recommendedOrderQty ?? '',
      resolvedMetrics.projectedStockoutDate ?? '',
      resolvedMetrics.weeklyOutlook?.week1 ?? '',
      resolvedMetrics.weeklyOutlook?.week2 ?? '',
      resolvedMetrics.weeklyOutlook?.week4 ?? '',
      resolvedMetrics.weeklyOutlook?.week8 ?? '',
      safetyStockFromForecast,
      available,
    ].join('|');

    const existing = insightsState[normalizedSku];
    if (existing?.key === metricsKey && (existing.status === 'ready' || existing.status === 'loading')) {
      return;
    }

    const timelinePayload = visibleSeries.map((point) => ({
      date: point.isoDate ?? point.date,
      phase: point.phase,
      actual: point.actual,
      forecast: point.fc,
      promo: point.promo ?? false,
    }));

    const payload: ForecastInsightRequestPayload = {
      product: {
        sku: activeProduct.sku,
        name: activeProduct.name,
        category: activeProduct.category,
        subCategory: activeProduct.subCategory,
        unit: activeProduct.unit,
        risk: activeProduct.risk,
      },
      metrics: resolvedMetrics,
      table: {
        safetyStock: safetyStockFromForecast,
        availableStock: available,
      },
      modifiers: {
        chartWindowMonths,
        promoExcluded: promoExclude,
      },
      timeline: timelinePayload,
    };

    setInsightsState((prev) => ({
      ...prev,
      [normalizedSku]: {
        status: 'loading',
        key: metricsKey,
        actionPlan: prev[normalizedSku]?.actionPlan ?? null,
      },
    }));

    void requestForecastInsight(productId, payload)
      .then((response) => {
        setInsightsState((prev) => ({
          ...prev,
          [normalizedSku]: {
            status: 'ready',
            key: metricsKey,
            data: response.insight,
            error: response.error ?? null,
            actionPlan: response.actionPlan ?? prev[normalizedSku]?.actionPlan ?? null,
            planFetchedAt: Date.now(),
          },
        }));
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error && error.message
            ? error.message
            : '인사이트를 불러오지 못했습니다.';
        setInsightsState((prev) => ({
          ...prev,
          [normalizedSku]: {
            status: 'error',
            key: metricsKey,
            error: message,
            actionPlan: existing?.actionPlan ?? null,
          },
        }));
      });
  }, [
    anchorSku,
    activeProduct,
    resolvedMetrics,
    chartWindowMonths,
    promoExclude,
    visibleSeries,
    forecastCache,
    insightsState,
  ]);

  const normalizedAnchorSku = anchorSku ? normalizeSku(anchorSku) : null;
  const insightEntry = normalizedAnchorSku ? insightsState[normalizedAnchorSku] : undefined;
  const resolvedInsight = insightEntry?.status === 'ready' && insightEntry.data ? insightEntry.data : null;
  const insightLoading = insightEntry?.status === 'loading';
  const insightErrorMessage =
    insightEntry?.status === 'error'
      ? insightEntry.error ?? '인사이트를 불러오지 못했습니다.'
      : null;
  const insightNotice = insightEntry?.status === 'ready' ? insightEntry.error ?? null : null;
  const resolvedActionPlan = insightEntry?.actionPlan ?? null;

  useEffect(() => {
    if (!anchorSku || !normalizedAnchorSku || !activeProduct) {
      return;
    }
    if (resolvedActionPlan) {
      return;
    }

    let cancelled = false;
    void fetchLatestActionPlan({ sku: anchorSku, productId: activeProduct.legacyProductId }).then((plan) => {
      if (cancelled || !plan) {
        return;
      }
      setInsightsState((prev) => ({
        ...prev,
        [normalizedAnchorSku]: {
          ...(prev[normalizedAnchorSku] ?? { status: 'idle' }),
          actionPlan: plan,
          planFetchedAt: Date.now(),
        },
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [anchorSku, normalizedAnchorSku, activeProduct, resolvedActionPlan]);

  const applyActionPlanUpdate = useCallback(
    (plan: ActionPlanRecord) => {
      const normalized = normalizeSku(plan.sku);
      setInsightsState((prev) => ({
        ...prev,
        [normalized]: {
          ...(prev[normalized] ?? { status: 'idle' }),
          actionPlan: plan,
          planFetchedAt: Date.now(),
        },
      }));
    },
    [setInsightsState],
  );

  const handleSubmitActionPlan = useCallback(
    (planId: string) => {
      if (actionPlanSubmitting) {
        return;
      }
      setActionPlanSubmitting(true);
      void submitActionPlan(planId)
        .then((plan) => {
          applyActionPlanUpdate(plan);
        })
        .catch((error) => {
          console.error(error);
          window.alert('실행 계획 검토 요청에 실패했습니다. 다시 시도해주세요.');
        })
        .finally(() => setActionPlanSubmitting(false));
    },
    [actionPlanSubmitting, applyActionPlanUpdate],
  );

  const handleApproveActionPlan = useCallback(
    (planId: string) => {
      if (actionPlanApproving) {
        return;
      }
      setActionPlanApproving(true);
      void approveActionPlan(planId)
        .then((plan) => {
          applyActionPlanUpdate(plan);
        })
        .catch((error) => {
          console.error(error);
          window.alert('실행 계획 승인에 실패했습니다. 다시 시도해주세요.');
        })
        .finally(() => setActionPlanApproving(false));
    },
    [actionPlanApproving, applyActionPlanUpdate],
  );

  const displayedChartData = chartGranularity === 'week' ? weeklyChartData : chartData;
  const effectiveForecastRange = chartGranularity === 'week' ? null : adjustedForecastRange;

  const chartLoading = anchorLoading && !anchorForecast && displayedChartData.length === 0;
  const panelLoading = anchorLoading && !anchorForecast && !resolvedMetrics;

  const activeWindowOptions = chartGranularity === 'week' ? WEEK_WINDOW_OPTIONS : CHART_WINDOW_OPTIONS;

  const chartToolbar = (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <div className="inline-flex overflow-hidden rounded-full border border-slate-200 bg-white">
        <button
          type="button"
          className={`px-3 py-1 font-semibold ${chartGranularity === 'month' ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
          onClick={() => setChartGranularity('month')}
        >
          월별
        </button>
        <button
          type="button"
          className={`px-3 py-1 font-semibold ${chartGranularity === 'week' ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
          onClick={() => setChartGranularity('week')}
        >
          주별
        </button>
      </div>
      {activeWindowOptions.map((option) => {
        const isActive = chartWindowMonths === option.months;
        return (
          <button
            key={`${chartGranularity}-${option.months}`}
            type="button"
            className={`rounded-lg border px-3 py-1 transition ${
              isActive
                ? 'border-indigo-500 bg-indigo-500 text-white shadow-sm'
                : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-900'
            }`}
            onClick={() => setChartWindowMonths(option.months)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="p-6 grid grid-cols-12 gap-6">
      <Card className="col-span-12">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className="font-semibold text-lg">수요예측</h2>
          <div className="text-xs flex flex-wrap items-center justify-end gap-1">
            <button
              className={`px-2 py-1 border rounded ${mode === 'perSku' ? 'bg-indigo-50' : ''}`}
              onClick={() => setMode('perSku')}
            >
              개별상품
            </button>
            <button
              className={`px-2 py-1 border rounded ${mode === 'overall' ? 'bg-indigo-50' : ''}`}
              onClick={() => setMode('overall')}
            >
              전체
            </button>
            <label className="inline-flex items-center gap-2 ml-4">
              <input
                type="checkbox"
                checked={promoExclude}
                onChange={(event) => setPromoExclude(event.target.checked)}
              />
              <span>프로모션 기간 제외</span>
            </label>
          </div>
        </div>
        <div className="max-h-[260px] overflow-auto rounded-2xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm text-slate-700">
            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_rgba(15,23,42,0.08)]">
              <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                <th className="px-5 py-3">SKU</th>
                <th className="px-4 py-3">품명</th>
                <th className="px-4 py-3">카테고리</th>
                <th className="px-4 py-3">하위카테고리</th>
                <th className="px-4 py-3">단위</th>
                <th className="px-4 py-3 text-right">표준재고(ROP)</th>
                <th className="px-4 py-3 text-right">안전재고</th>
                <th className="px-4 py-3 text-right">예측_1주후</th>
                <th className="px-4 py-3 text-right">예측_2주후</th>
                <th className="px-4 py-3 text-right">예측_4주후</th>
                <th className="px-4 py-3 text-right">예측_8주후</th>
              </tr>
            </thead>
            <tbody>
              {skus.map((row) => {
                const isSelected = selectedSku === row.sku;
                const normalizedSku = normalizeSku(row.sku);
                const forecastEntry = forecastCache[row.sku] ?? forecastCache[normalizedSku] ?? null;
                const metrics = forecastEntry?.metrics ?? null;
                const forecastProduct = forecastEntry?.product ?? null;
                const policyDraft = policyBySku.get(normalizedSku);
                const fallbackSnapshot = computeFallbackForecastSnapshot(row, policyDraft);
                const displayStandard = Number.isFinite(metrics?.reorderPoint)
                  ? Math.max(Math.round(metrics!.reorderPoint), 0)
                  : fallbackSnapshot.reorderPoint;
                const displaySafety = Number.isFinite(forecastProduct?.safetyStock)
                  ? Math.max(Math.round(forecastProduct!.safetyStock), 0)
                  : fallbackSnapshot.safetyStock;
                const weekly = metrics?.weeklyOutlook ?? fallbackSnapshot.weeklyOutlook;
                return (
                  <tr
                    key={row.sku}
                    onClick={() => handleRowClick(row.sku)}
                    className={`group cursor-pointer transition ${
                      isSelected
                        ? 'bg-primary-50/60'
                        : 'hover:bg-[#f9fafb]'
                    }`}
                    aria-selected={isSelected}
                  >
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex min-w-[96px] items-center gap-2 rounded-lg border-l-4 px-3 py-1 font-mono text-sm font-semibold ${
                          isSelected
                            ? 'border-primary-600 bg-primary-100 text-primary-800'
                            : 'border-primary-500 bg-primary-50 text-primary-700'
                        }`}
                      >
                        {row.sku}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="max-w-[220px] truncate font-semibold text-slate-900">{row.name}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{row.category}</td>
                    <td className="px-4 py-3 text-slate-600">{row.subCategory}</td>
                    <td className="px-4 py-3 text-slate-600">{row.unit || 'EA'}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-900">
                      {formatForecastValue(displayStandard)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-900">
                      {formatForecastValue(displaySafety)}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-700">
                      {formatForecastValue(weekly?.week1)}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-700">
                      {formatForecastValue(weekly?.week2)}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-700">
                      {formatForecastValue(weekly?.week4)}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-700">
                      {formatForecastValue(weekly?.week8)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <ForecastChartCard
        sku={anchorSku}
        chartData={displayedChartData}
        forecastRange={effectiveForecastRange}
        loading={chartLoading}
        error={anchorError}
        toolbar={chartToolbar}
        unit={activeProduct?.unit ?? 'EA'}
        accuracy={accuracyBadge}
      >
        <ForecastInsightsSection
          sku={anchorSku}
          productName={activeProduct?.name}
          metrics={resolvedMetrics}
          insight={resolvedInsight}
          fallbackExplanation={resolvedExplanation}
          actionPlan={resolvedActionPlan}
          fallbackActionItems={fallbackActionPlanItems}
          loading={panelLoading}
          insightLoading={insightLoading}
          actionPlanLoading={!resolvedActionPlan && insightLoading}
          actionPlanSubmitting={actionPlanSubmitting}
          actionPlanApproving={actionPlanApproving}
          onSubmitActionPlan={resolvedActionPlan ? handleSubmitActionPlan : undefined}
          onApproveActionPlan={resolvedActionPlan ? handleApproveActionPlan : undefined}
          insightError={insightErrorMessage ?? anchorError ?? null}
          insightNotice={insightNotice}
        />
      </ForecastChartCard>

    </div>
  );
};

interface CardProps {
  children: React.ReactNode;
  className?: string;
}

const Card: React.FC<CardProps> = ({ children, className = '' }) => (
  <motion.div
    className={`rounded-3xl border border-white/70 bg-white/60 p-5 shadow-lg backdrop-blur-sm ${className}`}
    initial={{ opacity: 0, y: 6 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.25 }}
  >
    {children}
  </motion.div>
);

interface NavItemProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

const NavItem: React.FC<NavItemProps> = ({ label, active, onClick }) => (
  <button
    onClick={onClick}
    className={`w-full rounded-2xl px-4 py-2 text-left text-sm font-medium transition-colors duration-150 ${
      active
        ? 'bg-indigo-500/90 text-white shadow-sm ring-1 ring-indigo-300/70'
        : 'text-indigo-950/70 hover:bg-indigo-200/40 hover:text-indigo-800'
    }`}
  >
    {label}
  </button>
);

const RiskTag: React.FC<{ risk: InventoryRisk }> = ({ risk }) => {
  const className =
    risk === '결품위험'
      ? 'bg-red-100 text-red-700'
      : risk === '과잉'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-emerald-100 text-emerald-700';
  return <span className={`px-2 py-1 rounded-full text-xs ${className}`}>{risk}</span>;
};

const ExpiryTag: React.FC<{ d: number | null | undefined }> = ({ d }) => {
  if (typeof d !== 'number' || !Number.isFinite(d)) {
    return <span className="px-2 py-1 rounded-full text-xs bg-slate-100 text-slate-500">만료 정보 없음</span>;
  }

  const normalized = Math.max(0, Math.floor(d));
  const className =
    normalized <= 14
      ? 'bg-red-100 text-red-700'
      : normalized <= 60
        ? 'bg-amber-100 text-amber-700'
        : 'bg-slate-100 text-slate-700';

  return <span className={`px-2 py-1 rounded-full text-xs ${className}`}>{formatExpiryBadge(normalized)}</span>;
};


function runSelfTests() {
  const mu = 100;
  const sigma = 30;
  const L = 10;
  const R = 7;
  const z1 = 1.28;
  const z2 = 2.33;
  const rho = 0.25;
  const leadTimeFactor = (lt: number) => Math.sqrt(lt * (1 + rho));
  const ss1 = Math.round(z1 * sigma * leadTimeFactor(L + R));
  const ss2 = Math.round(z2 * sigma * leadTimeFactor(L + R));
  console.assert(ss2 > ss1, 'Safety stock should increase with z');
  const rop1 = Math.round(mu * (L + R) + ss1);
  const rop2 = Math.round(mu * (L + R) + ss2);
  console.assert(rop2 > rop1, 'ROP should increase with higher SS');
}

if (typeof window !== 'undefined') {
  runSelfTests();
}

export { ProductsPage };
export const __test__ = {
  PoliciesPage,
  serviceLevelPercentageToZ,
  zToServiceLevelPercentage,
};
export default DeepflowDashboard;
