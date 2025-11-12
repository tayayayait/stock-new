import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { APIError, APIConnectionError, APIConnectionTimeoutError } from 'openai/error';
import {
  savePolicyDrafts,
  listPolicyDrafts,
  deletePolicyDrafts,
  upsertPolicyDraft,
  hasPolicyDraft,
  type PolicyDraftRecord,
} from '../stores/policiesStore.js';
import { getDailyMovementHistory } from '../stores/movementAnalyticsStore.js';
import { __getProductRecords, ensurePolicyDraftForProduct } from './products.js';

const apiKey = process.env.OPENAI_API_KEY;
const openaiClient = apiKey ? new OpenAI({ apiKey }) : null;
// Allow overriding the OpenAI chat model via env. Falls back to gpt-5.
const OPENAI_CHAT_MODEL = (process.env.OPENAI_CHAT_MODEL || 'gpt-5').trim();

const STRICT_FORECAST_FORMULA =
  String(process.env.STRICT_FORECAST_FORMULA ?? '').trim().toLowerCase() === 'true';
const FORECAST_RECOMMEND_MAX_DEVIATION_PCT = (() => {
  const raw = Number.parseFloat(String(process.env.FORECAST_RECOMMEND_MAX_DEVIATION_PCT ?? '').trim());
  if (Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return 0.15;
})();

const BASELINE_MONTH_COUNT = 3;
const MIN_BASELINE_MONTHS = 2;
const DEFAULT_LEAD_TIME_DAYS = 14;
const DEFAULT_SERVICE_LEVEL_PERCENT = 95;
const FIXED_SMOOTHING_ALPHA = 0.4;
const FIXED_CORRELATION_RHO = 0.25;
const EWMA_ANALYSIS_DAYS = 90;
const EWMA_ALPHA = 0.4;

type ForecastComputationMethod =
  | 'formula-monthly'
  | 'formula-monthly-partial'
  | 'daily90-ewma'
  | 'category-peer-median'
  | 'metrics-fallback';

interface PolicyRecommendationRequestBody {
  product?: {
    sku?: string;
    name?: string;
    segment?: string;
    abc?: string;
    xyz?: string;
    avgDaily?: number;
    onHand?: number;
    risk?: string;
    expiryDays?: number;
    pack?: number;
    casePack?: number;
  };
  policy?: {
    z?: number;
    L?: number;
    R?: number;
    moq?: number;
    pack?: number;
    casePack?: number;
    includeLTVar?: boolean;
    sigmaL?: number;
  };
  metrics?: {
    safetyStock?: number;
    target?: number;
    shortage?: number;
    recommendedOrder?: number;
  };
  userNote?: string;
}

interface PolicyPatch {
  z?: number;
  L?: number;
  R?: number;
  moq?: number;
  pack?: number;
  casePack?: number;
  includeLTVar?: boolean;
  sigmaL?: number;
}

interface PolicyRecommendation {
  patch: PolicyPatch;
  notes: string[];
  rawText: string;
}

interface PolicyDraftInput {
  sku?: unknown;
  name?: unknown;
  forecastDemand?: unknown;
  demandStdDev?: unknown;
  leadTimeDays?: unknown;
  serviceLevelPercent?: unknown;
  smoothingAlpha?: unknown;
  corrRho?: unknown;
}

interface PolicyBulkSaveRequestBody {
  items?: PolicyDraftInput[];
}

interface ForecastRecommendationRequestBody {
  product?: {
    sku?: string;
    name?: string;
    category?: string;
  };
  metrics?: {
    dailyAvg?: number;
    dailyStd?: number;
    avgOutbound7d?: number;
    onHand?: number;
    leadTimeDays?: number;
    serviceLevelPercent?: number;
  };
  history?: Array<{
    date?: string;
    actual?: number | null;
    forecast?: number | null;
  }>;
}

interface ForecastRecommendationResult {
  forecastDemand: number | null;
  demandStdDev: number | null;
  leadTimeDays: number | null;
  serviceLevelPercent: number | null;
  notes: string[];
  rawText: string;
}

const POLICY_SYSTEM_PROMPT = `당신은 재고관리 20년 경력 전문가로서 유통·리테일 수요 기획 팀을 돕는 재고 정책 컨설턴트입니다.
- SKU의 수요 패턴, ABC/XYZ 클래스, 재고 상태를 참고해 주기검토(R,S) 정책 조정안을 제안하세요.
- 실무에서 축적한 보수적 위험 관리 관점을 적용해 재고 과부족을 예방하는 현실적인 개선안을 강조하세요.
- 응답은 JSON으로만 작성하고, 키는 patch, notes, rawText 로 제한합니다.
- patch 에는 조정이 필요한 필드만 포함하며, z, L, R, moq, pack, casePack, includeLTVar, sigmaL 중 필요한 값만 제공합니다.
- notes 는 2~4개의 한국어 문장으로 구성된 배열이며, 각 항목은 데이터를 근거로 조정 이유를 설명합니다.
- rawText 는 1~2문장으로 요약된 참고 설명을 제공합니다.
- 정보가 부족하면 합리적 추정임을 명시하고, 사실과 추정을 구분하세요.`;

const FORECAST_SYSTEM_PROMPT = `You are a supply and inventory planning analyst. Use the provided context to recommend daily forecast demand, demand standard deviation, lead time (days), and service level percentage for safety stock planning.
- Use ONLY the last ${BASELINE_MONTH_COUNT} full months of demand history if available.
- Convert each month's actual quantity into a daily rate by dividing by the number of days in that month.
- forecastDemand MUST equal the mean of those daily rates, rounded to the nearest whole number.
- demandStdDev MUST equal the population standard deviation of those daily rates, rounded to the nearest whole number.
- If fewer than ${BASELINE_MONTH_COUNT} months have actual data, return null for forecastDemand and demandStdDev and explain the data gap in notes.
- Lead time and service level should stay close to the provided metrics unless there is a clear reason to change them.
- Respond ONLY in JSON with keys forecastDemand, demandStdDev, leadTimeDays, serviceLevelPercent, notes (array of short rationale strings), and rawText (brief summary). Use numeric values without units (serviceLevelPercent may include one decimal place).`;

const pickJsonBlock = (content: string): string => {
  const codeBlockMatch = content.match(/```json([\s\S]*?)```/i);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  const looseMatch = content.match(/\{[\s\S]*\}/);
  if (looseMatch) {
    return looseMatch[0];
  }
  return content;
};

const parseBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
};

const parseNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const toNullableNumber = (value: unknown): number | null => {
  const parsed = parseNumber(value);
  if (parsed === undefined || Number.isNaN(parsed)) {
    return null;
  }
  if (parsed < 0) {
    return 0;
  }
  return parsed;
};

const clampServiceLevelPercent = (value: number | null): number | null => {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.max(50, Math.min(99.9, value));
  return Math.round(clamped * 10) / 10;
};

const toNonNegativeInteger = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.max(0, Math.round(value));
  return Number.isFinite(rounded) ? rounded : null;
};

const resolveLeadTimeDays = (value: unknown): number | null => {
  const parsed = toNonNegativeInteger(typeof value === 'string' ? Number(value) : (value as number | null));
  if (parsed === null) {
    return null;
  }
  return parsed;
};

const resolveServiceLevel = (value: unknown): number | null => {
  const parsed = toNullableNumber(value);
  return clampServiceLevelPercent(parsed);
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

interface BaselineComputation {
  forecastDemand: number;
  demandStdDev: number;
  dailyValues: number[];
  method: ForecastComputationMethod;
  sampleCount?: number;
  windowLabel?: string;
}

const computeBaselineFromHistory = (
  history: ForecastRecommendationRequestBody['history'],
  options?: { minimumMonths?: number },
): BaselineComputation | null => {
  const minimumMonths = options?.minimumMonths ?? MIN_BASELINE_MONTHS;
  if (!Array.isArray(history) || history.length === 0) {
    return null;
  }

  const normalized = history
    .filter((entry) => entry && typeof entry.date === 'string' && Number.isFinite(entry.actual ?? Number.NaN))
    .map((entry) => ({
      date: (entry?.date as string).slice(0, 10),
      actual: Math.max(0, Math.round((entry?.actual as number) ?? 0)),
    }))
    .filter((entry) => !Number.isNaN(entry.actual))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (normalized.length === 0) {
    return null;
  }

  const uniqueByMonth = new Map<string, number>();
  normalized.forEach((entry) => {
    uniqueByMonth.set(entry.date, entry.actual);
  });

  const monthEntries = Array.from(uniqueByMonth.entries())
    .map(([date, quantity]) => ({ date, quantity }))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (monthEntries.length < minimumMonths) {
    return null;
  }

  const windowSize = Math.min(BASELINE_MONTH_COUNT, monthEntries.length);
  if (windowSize < minimumMonths) {
    return null;
  }

  const recentEntries = monthEntries.slice(-windowSize);
  const dailyValues = recentEntries
    .map((entry) => {
      const daysInMonth = getDaysInMonthFromIso(entry.date);
      if (!Number.isFinite(daysInMonth) || daysInMonth <= 0) {
        return null;
      }
      return entry.quantity / daysInMonth;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));

  if (dailyValues.length < minimumMonths) {
    return null;
  }

  const mean = dailyValues.reduce((sum, value) => sum + value, 0) / dailyValues.length;
  const variance = dailyValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / dailyValues.length;
  const stdDev = Math.sqrt(Math.max(variance, 0));
  const method: ForecastComputationMethod =
    dailyValues.length >= BASELINE_MONTH_COUNT ? 'formula-monthly' : 'formula-monthly-partial';

  return {
    forecastDemand: Math.max(0, Math.round(mean)),
    demandStdDev: Math.max(0, Math.round(stdDev)),
    dailyValues,
    method,
    sampleCount: dailyValues.length,
    windowLabel: `최근 ${dailyValues.length}개월`,
  };
};

const normalizeSkuValue = (value: string | undefined | null): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : null;
};

const formatIsoDate = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const buildMonthlyHistoryFromDaily = (
  sku: string,
  monthsLimit: number = Math.max(BASELINE_MONTH_COUNT, 6),
): ForecastRecommendationRequestBody['history'] => {
  const days = monthsLimit * 31;
  const dailyHistory = getDailyMovementHistory({ sku, days });
  if (dailyHistory.length === 0) {
    return [];
  }

  const totals = new Map<string, number>();
  dailyHistory.forEach((point) => {
    const date = new Date(`${point.date}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) {
      return;
    }
    const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const outbound = Number.isFinite(point.outbound) ? Math.max(Math.round(point.outbound), 0) : 0;
    totals.set(monthKey, (totals.get(monthKey) ?? 0) + outbound);
  });

  const sortedMonths = Array.from(totals.keys()).sort((a, b) => a.localeCompare(b));
  return sortedMonths.map((month) => ({
    date: month,
    actual: totals.get(month) ?? 0,
    forecast: null,
  }));
};

const computeDailyEwmaBaseline = (sku: string): BaselineComputation | null => {
  const days = EWMA_ANALYSIS_DAYS;
  const history = getDailyMovementHistory({ sku, days });
  if (history.length === 0) {
    return null;
  }

  const dailyLookup = new Map(history.map((point) => [point.date, Math.max(point.outbound, 0)]));

  const values: number[] = [];
  const today = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    date.setUTCDate(date.getUTCDate() - offset);
    const key = formatIsoDate(date);
    values.push(Math.max(dailyLookup.get(key) ?? 0, 0));
  }

  if (values.every((value) => value === 0)) {
    return null;
  }

  const alpha = Number.isFinite(EWMA_ALPHA) && EWMA_ALPHA > 0 && EWMA_ALPHA <= 1 ? EWMA_ALPHA : 0.4;
  let smoothed = values[0];
  for (let index = 1; index < values.length; index += 1) {
    smoothed = alpha * values[index] + (1 - alpha) * smoothed;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(Math.max(variance, 0));

  return {
    forecastDemand: Math.max(0, Math.round(smoothed)),
    demandStdDev: Math.max(0, Math.round(stdDev)),
    dailyValues: values,
    method: 'daily90-ewma',
    sampleCount: values.length,
    windowLabel: `최근 ${days}일`,
  };
};

const median = (values: number[]): number | null => {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
};

const computeCategoryPeerBaseline = (
  sku: string,
  explicitCategory?: string,
): BaselineComputation | null => {
  const records = __getProductRecords();
  if (!records || records.length === 0) {
    return null;
  }

  const normalizedSku = sku.trim().toUpperCase();
  const target =
    records.find((record) => record.sku.trim().toUpperCase() === normalizedSku) ??
    null;
  const category = explicitCategory ?? target?.category;
  if (!category) {
    return null;
  }

  const peers = records.filter((record) => record.category === category);
  if (peers.length === 0) {
    return null;
  }

  const avgValues = peers
    .map((record) => (Number.isFinite(record.dailyAvg) ? Math.max(record.dailyAvg, 0) : null))
    .filter((value): value is number => value !== null);
  const stdValues = peers
    .map((record) => (Number.isFinite(record.dailyStd) ? Math.max(record.dailyStd, 0) : null))
    .filter((value): value is number => value !== null);

  const medianAvg = median(avgValues);
  const medianStd = median(stdValues);
  if (medianAvg === null) {
    return null;
  }

  const resolvedStd = medianStd ?? medianAvg * 0.35;

  return {
    forecastDemand: Math.max(0, Math.round(medianAvg)),
    demandStdDev: Math.max(0, Math.round(resolvedStd)),
    dailyValues: [],
    method: 'category-peer-median',
    sampleCount: peers.length,
    windowLabel: `${category} 피어 ${peers.length}개`,
  };
};

const pickFiniteNumber = (...candidates: Array<number | undefined | null>): number | null => {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
};

const computeMetricsBaseline = (
  metrics: ForecastRecommendationRequestBody['metrics'] | undefined,
): BaselineComputation | null => {
  if (!metrics) {
    return null;
  }
  const avg = pickFiniteNumber(metrics.dailyAvg, metrics.avgOutbound7d);
  if (avg === null) {
    return null;
  }
  const std = pickFiniteNumber(metrics.dailyStd, metrics.dailyAvg ? metrics.dailyAvg * 0.35 : null);

  return {
    forecastDemand: Math.max(0, Math.round(avg)),
    demandStdDev: Math.max(0, Math.round(std ?? avg * 0.35)),
    dailyValues: [],
    method: 'metrics-fallback',
    windowLabel: '제품 메트릭',
  };
};

const formatComputationSummary = (baseline: BaselineComputation): string => {
  const forecastText = Number.isFinite(baseline.forecastDemand)
    ? `${baseline.forecastDemand.toLocaleString()} EA/일`
    : '-';
  const stdText = Number.isFinite(baseline.demandStdDev)
    ? `${baseline.demandStdDev.toLocaleString()} EA/일`
    : '-';
  return `예측 수요량 ${forecastText}, σ=${stdText} (${baseline.method})`;
};

const resolveForecastBaseline = (
  body: ForecastRecommendationRequestBody,
): { baseline: BaselineComputation | null; notes: string[] } => {
  const notes: string[] = [];
  const normalizedSku = normalizeSkuValue(body.product?.sku);

  const directBaseline = computeBaselineFromHistory(body.history, { minimumMonths: MIN_BASELINE_MONTHS });
  if (directBaseline) {
    if (directBaseline.method === 'formula-monthly') {
      notes.push(
        `${directBaseline.windowLabel ?? `최근 ${BASELINE_MONTH_COUNT}개월`} 월별 출고량을 일평균으로 환산해 공식 기반 값을 계산했습니다.`,
      );
    } else {
      notes.push(
        `${directBaseline.windowLabel ?? '최근 월별 데이터'}만 확보되어 공식 값을 계산했습니다. 추가 출고 데이터 확보 시 정밀도가 향상됩니다.`,
      );
    }
    notes.push(formatComputationSummary(directBaseline));
    return { baseline: directBaseline, notes };
  }

  if (normalizedSku) {
    const monthlyHistory = buildMonthlyHistoryFromDaily(normalizedSku);
    const monthlyBaseline = computeBaselineFromHistory(monthlyHistory, { minimumMonths: MIN_BASELINE_MONTHS });
    if (monthlyBaseline) {
      notes.push(
        `${monthlyBaseline.windowLabel ?? '최근 월별 데이터'}를 재집계해 공식 기반 값을 계산했습니다.`,
      );
      notes.push(formatComputationSummary(monthlyBaseline));
      return { baseline: monthlyBaseline, notes };
    }
  }

  if (normalizedSku) {
    const ewmaBaseline = computeDailyEwmaBaseline(normalizedSku);
    if (ewmaBaseline) {
      notes.push(
        `${ewmaBaseline.windowLabel ?? `최근 ${EWMA_ANALYSIS_DAYS}일`} 일별 출고량의 EWMA(α=${EWMA_ALPHA}) 기반으로 안전재고 입력값을 산출했습니다.`,
      );
      notes.push(formatComputationSummary(ewmaBaseline));
      return { baseline: ewmaBaseline, notes };
    }
  }

  if (normalizedSku) {
    const peerBaseline = computeCategoryPeerBaseline(normalizedSku, body.product?.category);
    if (peerBaseline) {
      notes.push(
        `${peerBaseline.windowLabel ?? '동일 카테고리 피어'}의 중앙값을 적용해 기본값을 추정했습니다.`,
      );
      notes.push(formatComputationSummary(peerBaseline));
      return { baseline: peerBaseline, notes };
    }
  }

  const metricsBaseline = computeMetricsBaseline(body.metrics);
  if (metricsBaseline) {
    notes.push('직접 제공된 제품 메트릭을 기반으로 기본값을 설정했습니다.');
    notes.push(formatComputationSummary(metricsBaseline));
    return { baseline: metricsBaseline, notes };
  }

  notes.push(`최근 ${BASELINE_MONTH_COUNT}개월 동안 충분한 출고 데이터가 없어 공식 기반 값을 계산하지 못했습니다.`);
  return { baseline: null, notes };
};

const computeRelativeDeviation = (candidate: number | null, baseline: number | null): number | null => {
  if (candidate === null || baseline === null) {
    return null;
  }
  if (!Number.isFinite(candidate) || !Number.isFinite(baseline)) {
    return null;
  }
  if (baseline === 0) {
    return candidate === 0 ? 0 : Infinity;
  }
  return Math.abs(candidate - baseline) / Math.abs(baseline);
};

const normalizePolicyDraft = (input: PolicyDraftInput): PolicyDraftRecord | null => {
  const skuText = typeof input.sku === 'string' ? input.sku.trim() : String(input.sku ?? '').trim();
  if (!skuText) {
    return null;
  }

  const nameText =
    typeof input.name === 'string'
      ? input.name.trim()
      : typeof input.name === 'number'
        ? String(input.name).trim()
        : '';

  return {
    sku: skuText,
    name: nameText || null,
    forecastDemand: toNullableNumber(input.forecastDemand),
    demandStdDev: toNullableNumber(input.demandStdDev),
    leadTimeDays: resolveLeadTimeDays(input.leadTimeDays),
    serviceLevelPercent: clampServiceLevelPercent(toNullableNumber(input.serviceLevelPercent)),
    smoothingAlpha: FIXED_SMOOTHING_ALPHA,
    corrRho: FIXED_CORRELATION_RHO,
  };
};

const parsePolicyRecommendation = (content: string): PolicyRecommendation => {
  const normalized = content.trim();
  if (!normalized) {
    throw new Error('LLM 응답이 비어 있습니다.');
  }

  const jsonBlock = pickJsonBlock(normalized);

  const allowedKeys = new Set<keyof PolicyPatch>([
    'z',
    'L',
    'R',
    'moq',
    'pack',
    'casePack',
    'includeLTVar',
    'sigmaL',
  ]);

  try {
    const parsed = JSON.parse(jsonBlock) as Partial<PolicyRecommendation> & {
      patch?: Record<string, unknown>;
      notes?: unknown;
      rawText?: unknown;
    };

    const patch: PolicyPatch = {};
    const rawPatch = parsed.patch ?? {};
    if (rawPatch && typeof rawPatch === 'object') {
      (Object.keys(rawPatch) as (keyof PolicyPatch)[]).forEach((key) => {
        if (!allowedKeys.has(key)) {
          return;
        }
        if (key === 'includeLTVar') {
          const boolValue = parseBoolean((rawPatch as Record<string, unknown>)[key]);
          if (typeof boolValue === 'boolean') {
            patch.includeLTVar = boolValue;
          }
          return;
        }
        const numberValue = parseNumber((rawPatch as Record<string, unknown>)[key]);
        if (numberValue !== undefined) {
          patch[key] = numberValue as never;
        }
      });
    }

    const rawNotes = parsed.notes;
    const notes: string[] = Array.isArray(rawNotes)
      ? rawNotes
          .filter((note): note is string => typeof note === 'string' && note.trim().length > 0)
          .map((note) => note.trim())
      : typeof rawNotes === 'string' && rawNotes.trim().length > 0
        ? [rawNotes.trim()]
        : [];

    const rawText =
      typeof parsed.rawText === 'string' && parsed.rawText.trim().length > 0
        ? parsed.rawText.trim()
        : normalized;

    return { patch, notes, rawText };
  } catch (error) {
    throw new Error('LLM 응답을 JSON으로 해석하지 못했습니다.');
  }
};

const buildUserPrompt = (body: PolicyRecommendationRequestBody): string => {
  const product = body.product ?? {};
  const policy = body.policy ?? {};
  const metrics = body.metrics ?? {};

  const lines: string[] = [];
  lines.push(`SKU: ${product.sku ?? '미확인'}`);
  lines.push(`품명: ${product.name ?? '미확인'}`);
  lines.push(`세그먼트: ${product.segment ?? '--'}`);
  lines.push(`ABC/XYZ: ${(product.abc ?? '--')}/${product.xyz ?? '--'}`);
  lines.push(`평균 일수요: ${product.avgDaily ?? '미상'} EA`);
  lines.push(`현재 재고: ${product.onHand ?? '미상'} EA`);
  if (product.risk) {
    lines.push(`재고 리스크: ${product.risk}`);
  }
  if (typeof product.expiryDays === 'number') {
    lines.push(`유통기한 잔여일: ${product.expiryDays}`);
  }
  lines.push(
    `현재 정책: z=${policy.z ?? '미상'}, L=${policy.L ?? '미상'}, R=${policy.R ?? '미상'}, MOQ=${policy.moq ?? '미상'}, Pack=${policy.pack ?? '미상'}, CasePack=${policy.casePack ?? '미상'}, LT변동=${policy.includeLTVar ? '포함' : '미포함'}, sigmaL=${policy.sigmaL ?? '미상'}`,
  );

  const metricDetails: string[] = [];
  if (typeof metrics.safetyStock === 'number') {
    metricDetails.push(`안전재고=${metrics.safetyStock}`);
  }
  if (typeof metrics.target === 'number') {
    metricDetails.push(`목표재고=${metrics.target}`);
  }
  if (typeof metrics.shortage === 'number') {
    metricDetails.push(`부족분=${metrics.shortage}`);
  }
  if (typeof metrics.recommendedOrder === 'number') {
    metricDetails.push(`권장발주=${metrics.recommendedOrder}`);
  }
  if (metricDetails.length > 0) {
    lines.push(`추가 지표: ${metricDetails.join(', ')}`);
  }

  if (body.userNote && body.userNote.trim().length > 0) {
    lines.push(`기존 메모: ${body.userNote.trim()}`);
  }

  lines.push('목표: 한국어로 간결한 정책 조정 patch와 근거를 제시');

  return lines.join('\n');
};

const buildForecastUserPrompt = (body: ForecastRecommendationRequestBody): string => {
  const product = body.product ?? {};
  const metrics = body.metrics ?? {};
  const lines: string[] = [];

  lines.push(`SKU: ${product.sku ?? 'UNKNOWN'}`);
  lines.push(`Name: ${product.name ?? 'N/A'}`);
  if (product.category) {
    lines.push(`Category: ${product.category}`);
  }
  if (typeof metrics.dailyAvg === 'number') {
    lines.push(`Daily average outbound: ${metrics.dailyAvg}`);
  }
  if (typeof metrics.dailyStd === 'number') {
    lines.push(`Daily standard deviation: ${metrics.dailyStd}`);
  }
  if (typeof metrics.avgOutbound7d === 'number') {
    lines.push(`Average outbound (7d): ${metrics.avgOutbound7d}`);
  }
  if (typeof metrics.onHand === 'number') {
    lines.push(`On-hand inventory: ${metrics.onHand}`);
  }
  if (typeof metrics.leadTimeDays === 'number') {
    lines.push(`Current lead time (days): ${metrics.leadTimeDays}`);
  }
  if (typeof metrics.serviceLevelPercent === 'number') {
    lines.push(`Current service level (%): ${metrics.serviceLevelPercent}`);
  }

  const history = Array.isArray(body.history)
    ? body.history.filter((entry) => entry && (entry.actual !== null || entry.forecast !== null))
    : [];
  if (history.length > 0) {
    lines.push('Recent demand history (date, actual -> forecast):');
    history.slice(-8).forEach((entry) => {
      const actual = entry?.actual ?? 'N/A';
      const forecast = entry?.forecast ?? 'N/A';
      lines.push(`- ${entry?.date ?? 'unknown'}: ${actual} -> ${forecast}`);
    });
  }

  lines.push('Goal: Suggest values for forecastDemand (EA/day), demandStdDev (EA/day), leadTimeDays, serviceLevelPercent.');
  lines.push('Respond ONLY with JSON.');

  return lines.join('\n');
};

const parseForecastRecommendation = (content: string): ForecastRecommendationResult => {
  const normalized = content.trim();
  if (!normalized) {
    throw new Error('LLM 응답이 비어 있습니다.');
  }

  const jsonBlock = pickJsonBlock(normalized);

  try {
    const parsed = JSON.parse(jsonBlock) as Record<string, unknown> & {
      notes?: unknown;
      rawText?: unknown;
    };

    const forecastDemand = toNullableNumber(parsed.forecastDemand ?? (parsed as { demand?: unknown }).demand);
    const demandStdDev = toNullableNumber(parsed.demandStdDev ?? (parsed as { sigma?: unknown }).sigma);
    const leadTimeDays = toNullableNumber(parsed.leadTimeDays ?? (parsed as { leadTime?: unknown }).leadTime);
    const serviceLevelPercent = clampServiceLevelPercent(
      toNullableNumber(parsed.serviceLevelPercent ?? (parsed as { serviceLevel?: unknown }).serviceLevel),
    );

    const rawNotes = parsed.notes;
    const notes: string[] = Array.isArray(rawNotes)
      ? rawNotes
          .filter((note): note is string => typeof note === 'string' && note.trim().length > 0)
          .map((note) => note.trim())
      : typeof rawNotes === 'string' && rawNotes.trim().length > 0
        ? [rawNotes.trim()]
        : [];

    const rawText =
      typeof parsed.rawText === 'string' && parsed.rawText.trim().length > 0
        ? parsed.rawText.trim()
        : normalized;

    return {
      forecastDemand,
      demandStdDev,
      leadTimeDays,
      serviceLevelPercent,
      notes,
      rawText,
    };
  } catch (error) {
    throw new Error('LLM 응답을 JSON으로 해석하지 못했습니다.');
  }
};

const extractHttpStatus = (err: unknown): number | undefined => {
  if (!err) {
    return undefined;
  }
  if (err instanceof APIError) {
    return err.status ?? undefined;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && Number.isFinite(status)) {
    return status;
  }
  if (typeof status === 'string' && status.trim()) {
    const parsed = Number(status);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number' && Number.isFinite(statusCode)) {
    return statusCode;
  }
  if (typeof statusCode === 'string' && statusCode.trim()) {
    const parsed = Number(statusCode);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const isLikelyNetworkError = (err: unknown): boolean => {
  if (!err) {
    return false;
  }
  if (err instanceof APIConnectionError || err instanceof APIConnectionTimeoutError) {
    return true;
  }
  const code = (err as { code?: unknown }).code;
  const normalized = typeof code === 'string' ? code.toUpperCase() : '';
  if (
    normalized.includes('ENOTFOUND') ||
    normalized.includes('ECONNRESET') ||
    normalized.includes('ETIMEDOUT') ||
    normalized.includes('ECONNREFUSED') ||
    normalized.includes('EAI_AGAIN') ||
    normalized.includes('CERT')
  ) {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string') {
    const lower = message.toLowerCase();
    return (
      lower.includes('network') ||
      lower.includes('fetch') ||
      lower.includes('timeout') ||
      lower.includes('getaddrinfo') ||
      lower.includes('tls') ||
      lower.includes('connection')
    );
  }
  return false;
};

const normalizeSku = (value: string): string => value.trim().toUpperCase();

export default async function policyRoutes(server: FastifyInstance) {
  server.get('/', async (request, reply) => {
    const productRecords = __getProductRecords();

    if (productRecords.length > 0) {
      productRecords.forEach((product) => {
        try {
          ensurePolicyDraftForProduct(product);
        } catch (error) {
          request.log.error(
            {
              err: error instanceof Error ? { name: error.name, message: error.message } : { value: error },
              sku: product.sku,
            },
            'Failed to ensure policy draft for product',
          );
        }
      });
    }

    const items = listPolicyDrafts();
    const validSkus = new Set(productRecords.map((product) => normalizeSku(product.sku)));

    if (validSkus.size === 0) {
      if (items.length > 0) {
        deletePolicyDrafts(items.map((item) => item.sku));
      }
      return reply.send({ success: true, items: [] });
    }

    const kept: PolicyDraftRecord[] = [];
    const orphanSkus: string[] = [];

    items.forEach((item) => {
      const normalized = normalizeSku(item.sku);
      if (validSkus.has(normalized)) {
        kept.push(item);
      } else {
        orphanSkus.push(normalized);
      }
    });

    if (orphanSkus.length > 0) {
      deletePolicyDrafts(orphanSkus);
    }

    return reply.send({ success: true, items: kept });
  });

  server.post('/bulk-save', async (request, reply) => {
    const body = (request.body as PolicyBulkSaveRequestBody | undefined) ?? {};
    const rawItems = Array.isArray(body.items) ? body.items : [];

    const drafts = rawItems
      .map((item) => normalizePolicyDraft(item))
      .filter((item): item is PolicyDraftRecord => item !== null);

    savePolicyDrafts(drafts);
    return reply.send({ success: true });
  });

  server.put('/:sku', async (request, reply) => {
    const params = (request.params as { sku?: string }) ?? {};
    const normalizedSku = normalizeSku(params.sku ?? '');
    if (!normalizedSku) {
      return reply
        .code(400)
        .send({ success: false, error: '유효한 SKU를 입력해 주세요.' });
    }

    const payload = normalizePolicyDraft({
      ...(request.body as PolicyDraftInput | undefined),
      sku: normalizedSku,
    });
    if (!payload) {
      return reply
        .code(400)
        .send({ success: false, error: '정책 데이터를 확인해 주세요.' });
    }

    const existed = hasPolicyDraft(normalizedSku);
    upsertPolicyDraft(payload);

    return reply.code(existed ? 200 : 201).send({ success: true, item: payload });
  });

  server.post('/recommend-forecast', async (request, reply) => {
    const body = (request.body as ForecastRecommendationRequestBody | undefined) ?? {};

    const baselineResolution = resolveForecastBaseline(body);
    const baseline = baselineResolution.baseline;
    const baselineForecast = baseline?.forecastDemand ?? null;
    const baselineStd = baseline?.demandStdDev ?? null;

    const fallbackLeadTime = resolveLeadTimeDays(body.metrics?.leadTimeDays) ?? DEFAULT_LEAD_TIME_DAYS;
    const fallbackServiceLevel =
      resolveServiceLevel(body.metrics?.serviceLevelPercent) ?? DEFAULT_SERVICE_LEVEL_PERCENT;

    let finalForecastDemand: number | null = baselineForecast;
    let finalDemandStdDev: number | null = baselineStd;
    let finalLeadTimeDays = fallbackLeadTime;
    let finalServiceLevelPercent = fallbackServiceLevel;
    let rawText = 'Baseline recommendation';
    let llmApplied = false;
    let deviationExceeded = false;

    const notes: string[] = [...baselineResolution.notes];
    if (baseline) {
      rawText = formatComputationSummary(baseline);
    }

    if (STRICT_FORECAST_FORMULA) {
      notes.push('STRICT_FORECAST_FORMULA가 활성화되어 공식 기반 값만 반환합니다.');
    }

    let llmResult: ForecastRecommendationResult | null = null;
    let llmError: Error | null = null;

    if (!STRICT_FORECAST_FORMULA && openaiClient) {
      try {
        const completion = await openaiClient.chat.completions.create({
          model: OPENAI_CHAT_MODEL,
          temperature: 0.2,
          messages: [
            { role: 'system', content: FORECAST_SYSTEM_PROMPT },
            { role: 'user', content: buildForecastUserPrompt(body) },
          ],
        });

        const content = completion.choices[0]?.message?.content;
        if (!content) {
          throw new Error('LLM에서 유효한 응답을 받지 못했습니다.');
        }

        llmResult = parseForecastRecommendation(content);
        llmApplied = true;
      } catch (error) {
        llmError = error instanceof Error ? error : new Error(String(error));
        request.log.error(error, 'Failed to generate forecast parameter recommendation');
      }
    } else if (!STRICT_FORECAST_FORMULA && !openaiClient) {
      notes.push('LLM 연동이 비활성화되어 공식 기반 값만 반환합니다.');
    }

    if (llmResult) {
      const candidateForecast =
        llmResult.forecastDemand !== null ? Math.max(0, Math.round(llmResult.forecastDemand)) : null;
      const candidateStd =
        llmResult.demandStdDev !== null ? Math.max(0, Math.round(llmResult.demandStdDev)) : null;

      const deviationForecast = computeRelativeDeviation(candidateForecast, baselineForecast);
      const deviationStd = computeRelativeDeviation(candidateStd, baselineStd);
      const deviations = [deviationForecast, deviationStd].filter(
        (value): value is number => value !== null && Number.isFinite(value),
      );
      const maxDeviation = deviations.length > 0 ? Math.max(...deviations) : null;

      if (
        baseline &&
        maxDeviation !== null &&
        Number.isFinite(maxDeviation) &&
        maxDeviation > FORECAST_RECOMMEND_MAX_DEVIATION_PCT
      ) {
        deviationExceeded = true;
        const deviationPct = Math.round(maxDeviation * 1000) / 10;
        notes.push(
          `LLM 제안값이 공식 기반 대비 편차 ${deviationPct}%를 초과해 공식 기반 값을 유지했습니다.`,
        );
      } else {
        if (candidateForecast !== null) {
          finalForecastDemand = candidateForecast;
        }
        if (candidateStd !== null) {
          finalDemandStdDev = candidateStd;
        }
        finalLeadTimeDays = resolveLeadTimeDays(llmResult.leadTimeDays) ?? finalLeadTimeDays;
        finalServiceLevelPercent = resolveServiceLevel(llmResult.serviceLevelPercent) ?? finalServiceLevelPercent;
        rawText = llmResult.rawText?.trim() || 'LLM recommendation';
      }
    }

    if (llmError) {
      const message =
        llmError.message && llmError.message.trim().length > 0
          ? llmError.message.trim()
          : 'LLM 호출 실패';
      notes.push(`LLM 호출에 실패해 공식 기반 값으로 대체했습니다. (${message})`);
    }

    const uniqueNotes = Array.from(new Set(notes.filter((note) => note.trim().length > 0)));

    request.log.info(
      {
        sku: body.product?.sku ?? null,
        strict: STRICT_FORECAST_FORMULA,
        llmApplied,
        deviationExceeded,
        baseline: baseline
          ? {
              forecastDemand: baseline.forecastDemand,
              demandStdDev: baseline.demandStdDev,
              dailyValues: baseline.dailyValues,
              method: baseline.method,
              sampleCount: baseline.sampleCount ?? baseline.dailyValues.length,
              windowLabel: baseline.windowLabel ?? null,
            }
          : null,
        result: {
          forecastDemand: finalForecastDemand,
          demandStdDev: finalDemandStdDev,
          leadTimeDays: finalLeadTimeDays,
          serviceLevelPercent: finalServiceLevelPercent,
        },
        llmError: llmError ? { name: llmError.name, message: llmError.message } : null,
      },
      'Forecast recommendation resolved',
    );

    return reply.send({
      success: true,
      recommendation: {
        forecastDemand: finalForecastDemand,
        demandStdDev: finalDemandStdDev,
        leadTimeDays: finalLeadTimeDays,
        serviceLevelPercent: finalServiceLevelPercent,
        notes: uniqueNotes,
        rawText,
      },
    });
  });

  server.post('/recommend', async (request, reply) => {
    const body = (request.body as PolicyRecommendationRequestBody | undefined) ?? {};

    if (!body.product?.sku || !body.product?.name || !body.policy) {
      return reply.code(400).send({ success: false, error: 'product 정보와 policy 정보가 필요합니다.' });
    }

    if (!openaiClient) {
      return reply
        .code(503)
        .send({ success: false, error: 'LLM 연동이 설정되지 않았습니다. OPENAI_API_KEY를 확인해주세요.' });
    }

    try {
      const completion = await openaiClient.chat.completions.create({
        model: OPENAI_CHAT_MODEL,
        temperature: 0.3,
        messages: [
          { role: 'system', content: POLICY_SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(body) },
        ],
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) {
        throw new Error('LLM에서 유효한 응답을 받지 못했습니다.');
      }

      const recommendation = parsePolicyRecommendation(content);

      return reply.send({ success: true, recommendation });
    } catch (error) {
      request.log.error(error, 'Failed to generate policy recommendation');
      const statusFromError = extractHttpStatus(error);
      let status: number;
      if (statusFromError === 401 || statusFromError === 403) {
        status = 401;
      } else if (statusFromError === 429) {
        status = 429;
      } else if (statusFromError && statusFromError >= 500 && statusFromError < 600) {
        status = 503;
      } else if (isLikelyNetworkError(error)) {
        status = 503;
      } else {
        status = 500;
      }

      let message: string;
      if (status === 401) {
        message = 'LLM API 키가 유효하지 않습니다. 서버 환경 변수 OPENAI_API_KEY를 확인해 주세요.';
      } else if (status === 429) {
        message = 'LLM 호출이 일시적으로 제한되었습니다. 잠시 후 다시 시도해 주세요.';
      } else if (status === 503) {
        message = 'LLM 서비스에 연결할 수 없습니다. 네트워크 상태나 서비스 상태를 확인해 주세요.';
      } else {
        message = '정책 추천 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
      }

      return reply.code(status).send({ success: false, error: message });
    }
  });
}
