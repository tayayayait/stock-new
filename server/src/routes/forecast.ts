import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { APIError, APIConnectionError, APIConnectionTimeoutError } from 'openai/error';

import {
  findForecastProduct,
  type ForecastProduct,
} from '../data/forecastSources.js';
import {
  buildSeasonalForecast,
  estimateStockoutDate,
  type ForecastPoint,
} from '../services/seasonalForecast.js';
import {
  buildWeeklyForecast,
  type WeeklyDemandPoint,
} from '../services/holtWintersWeekly.js';
import {
  summarizeWeeklyDemand,
  calculateReorderPointWeekly,
  calculateRecommendedOrderQuantity,
} from '../services/reorderPoint.js';
import { getWeeklyMovementHistory } from '../stores/movementAnalyticsStore.js';

const openaiApiKey = process.env.OPENAI_API_KEY;
const insightsClient = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;
const DEFAULT_CORRELATION_RHO = 0.25;
const MS_PER_DAY = 86_400_000;
const DAYS_PER_WEEK = 7;
const MS_PER_WEEK = MS_PER_DAY * DAYS_PER_WEEK;
const DEFAULT_WEEKLY_ALPHA = 0.3;
const DEFAULT_WEEKLY_BETA = 0.2;
const DEFAULT_WEEKLY_GAMMA = 0.3;
const WEEKLY_SEASONAL_PERIOD = 4;
const WEEKLY_FORECAST_HORIZON = 8;

const FORECAST_INSIGHT_SYSTEM_PROMPT = `당신은 한국어를 사용하는 글로벌 제조사의 수요/재고 기획 시니어 플래너입니다.
- 제공된 JSON 데이터를 분석해 경영진에게 보고할 간결한 인사이트를 작성하세요.
- 재고 과부족 위험, 리드타임, 프로모션 영향을 함께 고려해 현명한 조치안을 제시하세요.
- 응답은 JSON 객체로만 작성하며 키는 summary, drivers, watchouts, recommendations, rawText 만 사용합니다.
  - summary: 1~2문장 한국어 요약.
  - drivers: 2~4개의 문자열 배열, 수요/재고 패턴의 핵심 근거.
  - watchouts: 0~3개의 문자열 배열, 잠재 리스크나 모니터링 포인트.
  - recommendations: 최대 3개의 실행 권고 배열. 각 항목은 title, description, tone(info|warning|success 중 하나), metricLabel(선택)을 포함합니다.
  - rawText: 참조용 1문장 정도의 영어 또는 한국어 요약 (선택 사항).`;

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

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : null))
        .filter((entry): entry is string => Boolean(entry && entry.length > 0))
    : [];

const parseTone = (value: unknown): 'info' | 'warning' | 'success' | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'warning') return 'warning';
  if (normalized === 'success') return 'success';
  if (normalized === 'info' || normalized === 'information' || normalized === 'neutral') return 'info';
  return undefined;
};

const isLikelyNetworkError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }
  if (
    error instanceof APIConnectionError ||
    error instanceof APIConnectionTimeoutError ||
    (error instanceof Error && error.message && /\b(network|timeout|fetch)\b/i.test(error.message))
  ) {
    return true;
  }
  if (error instanceof Error) {
    const lower = error.message?.toLowerCase() ?? '';
    return (
      lower.includes('timeout') ||
      lower.includes('getaddrinfo') ||
      lower.includes('network') ||
      lower.includes('tls') ||
      lower.includes('connection')
    );
  }
  return false;
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
  const code = (err as { statusCode?: unknown }).statusCode;
  if (typeof code === 'number' && Number.isFinite(code)) {
    return code;
  }
  if (typeof code === 'string' && code.trim()) {
    const parsed = Number(code);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const monthLabels = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];

interface ForecastInsightRequestBody {
  product?: {
    sku?: string;
    name?: string;
    category?: string;
    subCategory?: string;
    unit?: string;
    risk?: string;
  };
  metrics?: {
    windowStart?: string;
    windowEnd?: string;
    outboundTotal?: number;
    avgDailyDemand?: number;
    currentTotalStock?: number;
    reorderPoint?: number;
    recommendedOrderQty?: number;
    projectedStockoutDate?: string | null;
    weeklyOutlook?: Record<string, number | null | undefined>;
  };
  table?: {
    safetyStock?: number;
    availableStock?: number;
    promoShare?: number;
  };
  modifiers?: {
    chartWindowMonths?: number;
    promoExcluded?: boolean;
  };
  timeline?: Array<{
    date?: string;
    phase?: string;
    actual?: number | null;
    forecast?: number | null;
    promo?: boolean;
  }>;
}

interface ParsedInsightRecommendation {
  id: string;
  title: string;
  description: string;
  tone?: 'info' | 'warning' | 'success';
  metricLabel?: string;
}

const toUtcDate = (value: string): Date => {
  const normalized = value.includes('T') ? value : `${value}T00:00:00Z`;
  return new Date(normalized);
};

const startOfUtcWeek = (date: Date): Date => {
  const base = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = base.getUTCDay();
  const offsetToMonday = (day + 6) % 7;
  base.setUTCDate(base.getUTCDate() - offsetToMonday);
  return base;
};

const formatWeekStart = (date: Date): string => {
  const start = startOfUtcWeek(date);
  const year = start.getUTCFullYear();
  const month = String(start.getUTCMonth() + 1).padStart(2, '0');
  const day = String(start.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const addWeeks = (date: Date, weeks: number): Date => new Date(date.getTime() + weeks * MS_PER_WEEK);

const formatDateLabel = (value: string): string => {
  const date = toUtcDate(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const toPromotionMap = (product: ForecastProduct): Record<string, string> => {
  const result: Record<string, string> = {};
  product.futurePromotions?.forEach((promo) => {
    const key = promo.month.includes('-01') ? promo.month : `${promo.month}-01`;
    result[key] = promo.note;
  });
  return result;
};

const buildWeeklyHistoryFromMonthly = (history: ForecastProduct['history']): WeeklyDemandPoint[] => {
  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }

  const weekly = new Map<
    string,
    {
      quantity: number;
      promo: boolean;
    }
  >();

  history.forEach((point) => {
    if (!point?.date || !Number.isFinite(point.quantity)) {
      return;
    }
    const monthStart = toUtcDate(point.date);
    const weeklyQuantity = point.quantity > 0 ? point.quantity / WEEKLY_SEASONAL_PERIOD : 0;

    for (let offset = 0; offset < WEEKLY_SEASONAL_PERIOD; offset += 1) {
      const weekStart = formatWeekStart(addWeeks(monthStart, offset));
      const existing = weekly.get(weekStart) ?? { quantity: 0, promo: false };
      existing.quantity += weeklyQuantity;
      existing.promo = existing.promo || Boolean(point.promo);
      weekly.set(weekStart, existing);
    }
  });

  return Array.from(weekly.entries())
    .map(([weekStart, data]) => ({
      weekStart,
      quantity: data.quantity,
      promo: data.promo,
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
};

const buildInsightContext = (product: ForecastProduct, body: ForecastInsightRequestBody) => {
  const availableStock = Math.max(product.onHand - product.reserved, 0);

  const baseProduct = {
    sku: product.sku,
    name: product.name,
    category: product.category,
    safetyStock: product.safetyStock,
    leadTimeDays: product.leadTimeDays,
    onHand: product.onHand,
    reserved: product.reserved,
    availableStock,
  } as Record<string, unknown>;

  if (body.product) {
    Object.entries(body.product).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        baseProduct[key] = value;
      }
    });
  }

  const metrics = { ...(body.metrics ?? {}) } as Record<string, unknown>;
  const table = {
    safetyStock: body.table?.safetyStock ?? product.safetyStock,
    availableStock: body.table?.availableStock ?? availableStock,
    promoShare: body.table?.promoShare ?? null,
  };
  const modifiers = { ...(body.modifiers ?? {}) };

  const timeline = Array.isArray(body.timeline)
    ? body.timeline
        .filter((entry) => entry && typeof entry.date === 'string')
        .slice(-24)
        .map((entry) => ({
          date: entry!.date!,
          phase: entry!.phase ?? null,
          actual: Number.isFinite(entry!.actual ?? Number.NaN) ? entry!.actual : null,
          forecast: Number.isFinite(entry!.forecast ?? Number.NaN) ? entry!.forecast : null,
          promo: Boolean(entry!.promo),
        }))
    : [];

  return {
    product: baseProduct,
    metrics,
    table,
    modifiers,
    timeline,
  };
};

const buildInsightPrompt = (context: ReturnType<typeof buildInsightContext>): string => {
  const payload = JSON.stringify(context, null, 2);
  return [
    '다음은 특정 SKU의 재고 및 수요 요약 데이터입니다.',
    '```json',
    payload,
    '```',
    '위 데이터를 분석하여 summary, drivers, watchouts, recommendations, rawText 필드를 포함한 JSON을 반환하세요.',
  ].join('\n');
};

const parseInsightCompletion = (content: string) => {
  const normalized = content.trim();
  if (!normalized) {
    throw new Error('LLM 응답이 비어 있습니다.');
  }

  const jsonBlock = pickJsonBlock(normalized);
  const parsed = JSON.parse(jsonBlock) as Record<string, unknown>;

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const drivers = toStringArray(parsed.drivers);
  const watchouts = toStringArray(parsed.watchouts);

  const recommendations = Array.isArray(parsed.recommendations)
    ? (parsed.recommendations as Array<Record<string, unknown>>)
        .map((item, index) => {
          const title = typeof item.title === 'string' ? item.title.trim() : '';
          const description = typeof item.description === 'string' ? item.description.trim() : '';
          if (!title || !description) {
            return null;
          }
          const idCandidate = typeof item.id === 'string' ? item.id.trim() : '';
          const metricLabel = typeof item.metricLabel === 'string' ? item.metricLabel.trim() : undefined;

          return {
            id: idCandidate || `rec-${index + 1}`,
            title,
            description,
            tone: parseTone(item.tone),
            metricLabel: metricLabel && metricLabel.length > 0 ? metricLabel : undefined,
          } satisfies ParsedInsightRecommendation;
        })
        .filter((entry): entry is ParsedInsightRecommendation => entry !== null)
        .slice(0, 3)
    : [];

  const rawText = typeof parsed.rawText === 'string' && parsed.rawText.trim().length > 0 ? parsed.rawText.trim() : undefined;

  return { summary, drivers, watchouts, recommendations, rawText };
};

const buildFallbackInsight = (product: ForecastProduct, context: ReturnType<typeof buildInsightContext>) => {
  const metrics = context.metrics as {
    windowStart?: string;
    windowEnd?: string;
    outboundTotal?: number;
    avgDailyDemand?: number;
    currentTotalStock?: number;
    reorderPoint?: number;
    recommendedOrderQty?: number;
    projectedStockoutDate?: string | null;
    weeklyOutlook?: Record<string, number | null | undefined>;
  };

  const table = context.table as { safetyStock?: number; availableStock?: number; promoShare?: number | null };
  const available = Number.isFinite(table.availableStock)
    ? Math.max(Number(table.availableStock), 0)
    : Math.max(product.onHand - product.reserved, 0);
  const safetyStockValue = Number.isFinite(table.safetyStock) ? Math.max(Number(table.safetyStock), 0) : product.safetyStock;

  const summaryParts: string[] = [];
  if (metrics?.windowStart && metrics?.windowEnd) {
    summaryParts.push(`최근 ${metrics.windowStart} ~ ${metrics.windowEnd} 기준으로`);
  }
  if (Number.isFinite(metrics?.avgDailyDemand)) {
    summaryParts.push(`일 평균 수요는 약 ${formatNumber(metrics!.avgDailyDemand ?? 0)}개입니다.`);
  }
  summaryParts.push(`현재 가용재고는 약 ${formatNumber(available)}개이며 안전재고 설정은 ${formatNumber(safetyStockValue)}개입니다.`);

  const drivers: string[] = [];
  if (Number.isFinite(metrics?.outboundTotal)) {
    drivers.push(`최근 출고 총량 ${formatNumber(metrics!.outboundTotal ?? 0)}개`);
  }
  const weekly = metrics?.weeklyOutlook ?? {};
  if (Number.isFinite(weekly?.week1 ?? Number.NaN)) {
    drivers.push(`1주 예측 수요 ${formatNumber(weekly!.week1 ?? 0)}개`);
  }
  if (Number.isFinite(weekly?.week4 ?? Number.NaN)) {
    drivers.push(`4주 예측 수요 ${formatNumber(weekly!.week4 ?? 0)}개`);
  }

  const watchouts: string[] = [];
  if (typeof metrics?.projectedStockoutDate === 'string' && metrics.projectedStockoutDate) {
    watchouts.push(`재고 소진 예상일 ${new Date(metrics.projectedStockoutDate).toLocaleDateString('ko-KR')}`);
  }
  if (available < safetyStockValue) {
    watchouts.push('가용재고가 안전재고 미만입니다. 보충 계획을 점검하세요.');
  }

  const recommendations: ParsedInsightRecommendation[] = [];
  if (available < safetyStockValue) {
    recommendations.push({
      id: 'replenish',
      title: '재고 보충 필요',
      description: '안전재고 이하로 내려갔습니다. 리드타임을 반영한 긴급 발주 또는 재배치를 검토하세요.',
      tone: 'warning',
      metricLabel: `${formatNumber(safetyStockValue - available)}개 부족`,
    });
  } else if (safetyStockValue > 0 && available > safetyStockValue * 1.6) {
    recommendations.push({
      id: 'optimize',
      title: '재고 최적화',
      description: '안전재고 대비 여유가 크므로 판촉이나 타 창고 이동으로 재고를 최적화할 여지가 있습니다.',
      tone: 'info',
      metricLabel: `${formatNumber(available - safetyStockValue)}개 초과`,
    });
  }
  if (Number.isFinite(metrics?.recommendedOrderQty) && (metrics?.recommendedOrderQty ?? 0) > 0) {
    recommendations.push({
      id: 'order-plan',
      title: '권장 발주량 확인',
      description: '기계 학습 모델이 산출한 권장 발주량을 검토하고, 현장 제약(중량, MOQ 등)을 반영해 확정하세요.',
      tone: 'success',
      metricLabel: `${formatNumber(metrics!.recommendedOrderQty ?? 0)}개 제안`,
    });
  }

  return {
    summary: summaryParts.join(' '),
    drivers,
    watchouts,
    recommendations,
    generatedAt: new Date().toISOString(),
    source: 'fallback' as const,
  };
};

const sliceTimeline = (timeline: ForecastPoint[], maxHistoryPoints = 18): ForecastPoint[] => {
  const history = timeline.filter((point) => point.phase === 'history');
  const forecast = timeline.filter((point) => point.phase === 'forecast');
  const trimmedHistory = history.slice(-maxHistoryPoints);
  return [...trimmedHistory, ...forecast];
};

const sum = (values: number[]): number => values.reduce((acc, value) => acc + value, 0);

const formatNumber = (value: number): string => Math.round(value).toLocaleString();

const buildExplanation = (
  product: ForecastProduct,
  trimmedTimeline: ForecastPoint[],
  mape: number | null,
  seasonalFactors: number[],
  trainingStart: string,
  trainingEnd: string,
): {
  summary: string;
  drivers: string[];
  details: string;
  model: {
    name: string;
    seasonalPeriod: number;
    trainingWindow: string;
    generatedAt: string;
    mape: number | null;
  };
} => {
  const historyPoints = trimmedTimeline.filter((point) => point.phase === 'history');
  const forecastPoints = trimmedTimeline.filter((point) => point.phase === 'forecast');

  const months = historyPoints.length;
  const totalHistory = sum(historyPoints.map((point) => point.actual ?? 0));
  const averageHistory = months > 0 ? totalHistory / months : 0;

  const firstActual = historyPoints[0]?.actual ?? 0;
  const lastActual = historyPoints[historyPoints.length - 1]?.actual ?? 0;
  const trendChange = firstActual > 0 ? ((lastActual - firstActual) / firstActual) * 100 : 0;
  const trendDescription =
    trendChange > 7
      ? `최근 ${months}개월 동안 약 ${Math.round(trendChange)}% 증가했습니다`
      : trendChange < -7
        ? `최근 ${months}개월 동안 약 ${Math.abs(Math.round(trendChange))}% 감소했습니다`
        : '최근 수요가 안정적으로 유지되고 있습니다';

  const nextForecast = forecastPoints[0]?.forecast ?? lastActual;
  const promoShare = totalHistory > 0
    ? (sum(historyPoints.filter((point) => point.promo).map((point) => point.actual ?? 0)) / totalHistory) * 100
    : 0;

  const peakFactor = Math.max(...seasonalFactors);
  const peakMonthIndex = seasonalFactors.indexOf(peakFactor);
  const peakMonthLabel = peakMonthIndex >= 0 ? monthLabels[peakMonthIndex] : null;

  const summary = `${product.name} 월평균 출고는 약 ${formatNumber(averageHistory)}개이며 ${trendDescription}. 다음 달 예측치는 ${formatNumber(nextForecast)}개 수준입니다.`;

  const drivers: string[] = [];
  if (peakMonthLabel) {
    drivers.push(`${peakMonthLabel} 시즌이 평균 대비 ${(peakFactor * 100 - 100).toFixed(1)}% 높은 패턴으로 나타납니다.`);
  }
  drivers.push(
    mape !== null
      ? `MAPE ${mape.toFixed(1)}% 기반 계절-추세 모델(학습 구간 ${formatDateLabel(trainingStart)} ~ ${formatDateLabel(trainingEnd)})`
      : `계절-추세 모델(학습 구간 ${formatDateLabel(trainingStart)} ~ ${formatDateLabel(trainingEnd)})`,
  );
  if (promoShare > 0) {
    drivers.push(`히스토리 출고 중 프로모션 비중 ${promoShare.toFixed(1)}% 반영됨.`);
  }

  const promoForecastNotes = forecastPoints
    .filter((point) => point.promo)
    .map((point) => `${formatDateLabel(point.date)} 예정 프로모션 반영`);
  drivers.push(...promoForecastNotes);

  const details = `${product.category} · 평균 ${formatNumber(averageHistory)}개/월 · 다음 달 ${formatNumber(nextForecast)}개 예측`;

  return {
    summary,
    drivers,
    details,
    model: {
      name: 'Seasonal trend regression',
      seasonalPeriod: seasonalFactors.length,
      trainingWindow: `${formatDateLabel(trainingStart)} ~ ${formatDateLabel(trainingEnd)} (${historyPoints.length}개월)`,
      generatedAt: new Date().toISOString(),
      mape,
    },
  };
};

export default async function forecastRoutes(server: FastifyInstance) {
  server.get('/:productId', async (request, reply) => {
    const productIdParam = (request.params as { productId: string }).productId;
    const productId = Number(productIdParam);

    if (!Number.isFinite(productId)) {
      return reply.code(400).send({ error: 'productId 파라미터가 올바르지 않습니다.' });
    }

    const product = findForecastProduct(productId);
    if (!product) {
      return reply.code(404).send({ error: '요청한 상품의 예측 데이터를 찾지 못했습니다.' });
    }

    if (!product.history || product.history.length < 6) {
      return reply
        .code(404)
        .send({ error: '예측을 생성하기에 충분한 히스토리 데이터가 없습니다.' });
    }

    try {
      const promoMap = toPromotionMap(product);
      const model = buildSeasonalForecast(product.history, {
        horizon: 6,
        upcomingPromotions: promoMap,
      });

      const timeline = sliceTimeline(model.timeline);
      const historyPoints = timeline.filter((point) => point.phase === 'history');
      const forecastPoints = timeline.filter((point) => point.phase === 'forecast');

      const windowStart = historyPoints[0]?.date ?? model.trainingStart;
      const windowEnd = historyPoints[historyPoints.length - 1]?.date ?? model.trainingEnd;
      const outboundTotal = sum(historyPoints.map((point) => point.actual ?? 0));
      const promoOutbound = sum(historyPoints.filter((point) => point.promo).map((point) => point.actual ?? 0));
      const regularOutbound = outboundTotal - promoOutbound;
      const avgDailyDemand = historyPoints.length > 0 ? Math.round(outboundTotal / (historyPoints.length * 30)) : 0;
      const availableStock = Math.max(product.onHand - product.reserved, 0);

      const weeklyMovements = getWeeklyMovementHistory({ sku: product.sku, days: DAYS_PER_WEEK * 52 });
      let weeklyHistory: WeeklyDemandPoint[] = weeklyMovements.map((point) => ({
        weekStart: point.weekStart,
        quantity: Math.max(point.outbound, 0),
        promo: false,
      }));
      if (weeklyHistory.length === 0) {
        weeklyHistory = buildWeeklyHistoryFromMonthly(product.history);
      }

      const smoothingAlpha =
        Number.isFinite(product.smoothingAlpha ?? Number.NaN) && (product.smoothingAlpha ?? 0) > 0
          ? (product.smoothingAlpha as number)
          : DEFAULT_WEEKLY_ALPHA;

      const weeklyForecast = buildWeeklyForecast(weeklyHistory, {
        alpha: smoothingAlpha,
        beta: DEFAULT_WEEKLY_BETA,
        gamma: DEFAULT_WEEKLY_GAMMA,
        seasonalPeriod: WEEKLY_SEASONAL_PERIOD,
        horizon: WEEKLY_FORECAST_HORIZON,
      });
      const weeklyHistoryPoints = weeklyForecast.timeline.filter((point) => point.phase === 'history');
      const weeklyForecastPoints = weeklyForecast.timeline.filter((point) => point.phase === 'forecast');

      const weeklySummary = summarizeWeeklyDemand(
        weeklyHistoryPoints.map((point) => ({
          weekStart: point.weekStart,
          quantity: point.actual ?? 0,
          promo: point.promo ?? false,
        })),
      );

      const leadTimeWeeks = product.leadTimeDays > 0 ? product.leadTimeDays / DAYS_PER_WEEK : 0;
      const serviceLevelZ =
        Number.isFinite(product.serviceLevelZ ?? Number.NaN) && (product.serviceLevelZ ?? 0) > 0
          ? (product.serviceLevelZ as number)
          : 1.6449;

      const reorderPointWeekly = calculateReorderPointWeekly({
        meanWeeklyDemand: weeklySummary.mean,
        stdWeeklyDemand: weeklySummary.stdDev,
        leadTimeWeeks,
        serviceLevelZ,
      });
      const recommendedOrderQtyWeekly = calculateRecommendedOrderQuantity(reorderPointWeekly, availableStock);

      const forecastValueAt = (index: number): number => {
        if (weeklyForecastPoints.length === 0) {
          return 0;
        }
        if (index < weeklyForecastPoints.length) {
          return weeklyForecastPoints[index].forecast;
        }
        return weeklyForecastPoints[weeklyForecastPoints.length - 1].forecast;
      };

      const weeklyOutlook = {
        week1: forecastValueAt(0),
        week2: forecastValueAt(1),
        week4: forecastValueAt(3),
        week8: forecastValueAt(7),
      };

      const avgWeeklyDemand = Math.round(weeklySummary.mean);
      const weeklyStdDev = Math.round(weeklySummary.stdDev);
      const leadTimeWeeksLabel = leadTimeWeeks > 0 ? leadTimeWeeks.toFixed(2) : '0';
      const sqrtLeadTimeLabel = leadTimeWeeks > 0 ? Math.sqrt(leadTimeWeeks).toFixed(2) : '0';
      const serviceLevelZLabel = serviceLevelZ.toFixed(2);

      const reorderPointBase = Math.round(avgDailyDemand * product.leadTimeDays + product.safetyStock);
      const reorderPoint = Math.max(product.configuredReorderPoint, reorderPointBase);
      const recommendedOrderQty = Math.max(reorderPoint - availableStock, 0);
      const stockoutDate = estimateStockoutDate(availableStock, forecastPoints);

      const explanation = buildExplanation(
        product,
        timeline,
        model.mape,
        model.seasonalFactors,
        model.trainingStart,
        model.trainingEnd,
      );

      const response = {
        product: {
          id: product.id,
          sku: product.sku,
          name: product.name,
          safetyStock: product.safetyStock,
          leadTimeDays: product.leadTimeDays,
          serviceLevelPercent: product.serviceLevelPercent,
          serviceLevelZ: product.serviceLevelZ,
          smoothingAlpha: product.smoothingAlpha,
          corrRho: product.corrRho,
          configuredReorderPoint: product.configuredReorderPoint,
          onHand: product.onHand,
          reserved: product.reserved,
          availableStock,
        },
        metrics: {
          windowStart,
          windowEnd,
          outboundTotal,
          outboundReasons: {
            regular: regularOutbound,
            promo: promoOutbound,
          },
          avgDailyDemand,
          avgWeeklyDemand,
          weeklyStdDev,
          weeklyStats: {
            mean: weeklySummary.mean,
            stdDev: weeklySummary.stdDev,
            sampleSize: weeklySummary.sampleSize,
            totalQuantity: weeklySummary.totalQuantity,
          },
          currentTotalStock: availableStock,
          reorderPoint,
          recommendedOrderQty,
          reorderPointWeekly,
          recommendedOrderQtyWeekly,
          projectedStockoutDate: stockoutDate,
          weeklyOutlook,
        },
        sampleCalculation: {
          safetyStock: `안전재고 ≈ Z × σ × √(${product.leadTimeDays} × (1 + ${(Number.isFinite(product.corrRho ?? Number.NaN) ? product.corrRho : DEFAULT_CORRELATION_RHO).toFixed(2)})) ≈ ${product.safetyStock}`,
          reorderPoint: `평균 일수요 ${avgDailyDemand} × 리드타임 ${product.leadTimeDays}일 + 안전재고 ${product.safetyStock} ≈ ${reorderPoint}`,
          recommendedOrderQty: `max(ROP ${reorderPoint} - 가용 ${availableStock}, 0) = ${recommendedOrderQty}`,
          reorderPointWeekly:
            leadTimeWeeks > 0
              ? `주간 평균 수요 ${avgWeeklyDemand} × 리드타임 ${leadTimeWeeksLabel}주 + Z ${serviceLevelZLabel} × 주간 표준편차 ${weeklyStdDev} × √${sqrtLeadTimeLabel} ≈ ${reorderPointWeekly}`
              : '리드타임이 0주로 설정되어 주간 ROP를 계산할 수 없습니다.',
          recommendedOrderQtyWeekly: `max(주간 ROP ${reorderPointWeekly} - 가용 ${availableStock}, 0) = ${recommendedOrderQtyWeekly}`,
        },
        timeline,
        weeklyForecast: {
          timeline: weeklyForecast.timeline,
          mape: weeklyForecast.mape,
          seasonalPeriod: weeklyForecast.seasonalPeriod,
          seasonalFactors: weeklyForecast.seasonalFactors,
          smoothing: weeklyForecast.smoothing,
          level: weeklyForecast.level,
          trend: weeklyForecast.trend,
        },
        explanation,
      };

      return reply.send(response);
    } catch (error) {
      request.log.error(error, 'Failed to build forecast response');
      return reply.code(500).send({ error: '수요예측 데이터를 생성하지 못했습니다.' });
    }
  });

  server.post('/:productId/insights', async (request, reply) => {
    const productIdParam = (request.params as { productId: string }).productId;
    const productId = Number(productIdParam);

    if (!Number.isFinite(productId)) {
      return reply.code(400).send({ error: 'productId 파라미터가 올바르지 않습니다.' });
    }

    const product = findForecastProduct(productId);
    if (!product) {
      return reply.code(404).send({ error: '요청한 상품의 예측 데이터를 찾지 못했습니다.' });
    }

    const body = (request.body as ForecastInsightRequestBody | undefined) ?? {};
    const context = buildInsightContext(product, body);

    if (!insightsClient) {
      const fallback = buildFallbackInsight(product, context);
      return reply.send({
        insight: fallback,
        error: 'LLM 분석 기능이 활성화되지 않아 기본 인사이트를 제공합니다.',
      });
    }

    try {
      const completion = await insightsClient.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.25,
        messages: [
          { role: 'system', content: FORECAST_INSIGHT_SYSTEM_PROMPT },
          { role: 'user', content: buildInsightPrompt(context) },
        ],
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) {
        throw new Error('LLM에서 유효한 응답을 받지 못했습니다.');
      }

      const parsed = parseInsightCompletion(content);
      const insight = {
        summary: parsed.summary || '생성된 요약이 없습니다.',
        drivers: parsed.drivers,
        watchouts: parsed.watchouts,
        recommendations: parsed.recommendations,
        generatedAt: new Date().toISOString(),
        source: 'llm' as const,
        rawText: parsed.rawText,
      };

      return reply.send({ insight });
    } catch (error) {
      request.log.error(error, 'Failed to generate forecast insight');
      const fallback = buildFallbackInsight(product, context);
      const status = extractHttpStatus(error);
      const message =
        status === 401 || status === 403
          ? 'LLM 인증 정보를 확인해주세요. 기본 인사이트를 제공합니다.'
          : 'LLM 분석을 생성하지 못해 기본 인사이트를 제공합니다.';
      return reply.send({ insight: fallback, error: message });
    }
  });
}
