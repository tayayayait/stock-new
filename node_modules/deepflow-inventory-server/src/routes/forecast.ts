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
import { saveActionPlan } from '../stores/actionPlanStore.js';
import type { ActionPlanItem } from '../../../shared/actionPlans/types.js';

const openaiApiKey = process.env.OPENAI_API_KEY;
const insightsClient = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;
// Allow overriding the OpenAI chat model used for insights via env.
const OPENAI_CHAT_MODEL = (process.env.OPENAI_CHAT_MODEL || 'gpt-5').trim();
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
- 제공된 JSON 데이터를 분석해 경영진이 즉시 이해할 수 있는 통찰과 실행계획을 작성하세요.
- 재고 과부족 위험, 리드타임, 프로모션, 시즌성, 공급제약을 함께 고려해 “Upside/Downside Risk”와 “Who/What/When/KPI” 구조를 따르세요.
- 응답은 JSON 객체 1개로만 작성하며 다음 키를 포함합니다: summary, insights, action_items, rawText(선택), language(선택).
  - summary: 1~2문장 한국어 요약.
  - insights: 2~4개의 배열. 각 항목은 { side(up|down), driver, impact(high|medium|low), confidence(0~1), evidence }를 포함합니다.
  - action_items: 2~4개의 배열. 각 항목은 { id, who, what, when, kpi:{ name, target, window }, rationale, confidence } 구조로 작성합니다.
  - rawText: 선택적으로 1문장 요약 (한국어나 영어).
  - language: 'ko' 또는 'en'. 한국어를 기본으로 사용하세요.
- 제공되지 않은 수치는 임의로 생성하지 말고, 데이터가 부족하면 "근거 불충분"이라고 명시하세요.`;

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
    '위 데이터를 분석해 summary, insights(up/down 위험), action_items(Who/What/When/KPI) 필드를 포함한 JSON을 반환하세요.',
  ].join('\n');
};

const parseRiskSide = (value: unknown): 'upside' | 'downside' => {
  if (typeof value !== 'string') {
    return 'downside';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith('up')) {
    return 'upside';
  }
  if (normalized.startsWith('down')) {
    return 'downside';
  }
  return normalized === 'positive' ? 'upside' : 'downside';
};

const parseImpactLevel = (value: unknown): 'high' | 'medium' | 'low' => {
  if (typeof value !== 'string') {
    return 'medium';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'high') {
    return 'high';
  }
  if (normalized === 'low') {
    return 'low';
  }
  return 'medium';
};

const clampConfidence = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : null;
  if (!Number.isFinite(numeric)) {
    return 0.6;
  }
  return Math.max(0, Math.min(Number(numeric), 1));
};

const parseInsightCompletion = (content: string) => {
  const normalized = content.trim();
  if (!normalized) {
    throw new Error('LLM 응답이 비어 있습니다.');
  }

  const jsonBlock = pickJsonBlock(normalized);
  const parsed = JSON.parse(jsonBlock) as Record<string, unknown>;

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const language = typeof parsed.language === 'string' ? parsed.language.trim() : 'ko';
  const rawText = typeof parsed.rawText === 'string' && parsed.rawText.trim().length > 0 ? parsed.rawText.trim() : undefined;

  const risks = Array.isArray(parsed.insights)
    ? (parsed.insights as Array<Record<string, unknown>>)
        .map((entry, index) => {
          const driver = typeof entry.driver === 'string' ? entry.driver.trim() : '';
          const evidence = typeof entry.evidence === 'string' ? entry.evidence.trim() : '';
          if (!driver || !evidence) {
            return null;
          }
          const idCandidate = typeof entry.id === 'string' ? entry.id.trim() : '';
          return {
            id: idCandidate || `risk-${index + 1}`,
            side: parseRiskSide(entry.side),
            driver,
            evidence,
            impact: parseImpactLevel(entry.impact),
            confidence: clampConfidence(entry.confidence),
          };
        })
        .filter((entry): entry is {
          id: string;
          side: 'upside' | 'downside';
          driver: string;
          evidence: string;
          impact: 'high' | 'medium' | 'low';
          confidence: number;
        } => Boolean(entry))
    : [];

  const actionItems = Array.isArray(parsed.action_items)
    ? (parsed.action_items as Array<Record<string, unknown>>)
        .map((item, index): ActionPlanItem | null => {
          const who = typeof item.who === 'string' ? item.who.trim() : '';
          const what = typeof item.what === 'string' ? item.what.trim() : '';
          const when = typeof item.when === 'string' ? item.when.trim() : '';
          const rationale = typeof item.rationale === 'string' ? item.rationale.trim() : '';
          const kpi = (item.kpi ?? {}) as Record<string, unknown>;
          const kpiName = typeof kpi.name === 'string' ? kpi.name.trim() : '';
          const kpiTarget =
            typeof kpi.target === 'number' || typeof kpi.target === 'string'
              ? (kpi.target as number | string)
              : '';
          const kpiWindow = typeof kpi.window === 'string' ? kpi.window.trim() : '';

          if (!who || !what || !when || !kpiName || !kpiWindow) {
            return null;
          }

          const idCandidate = typeof item.id === 'string' ? item.id.trim() : `plan-${index + 1}`;
          return {
            id: idCandidate,
            who,
            what,
            when,
            rationale,
            confidence: clampConfidence(item.confidence),
            kpi: {
              name: kpiName,
              target: kpiTarget,
              window: kpiWindow,
            },
          };
        })
        .filter((entry): entry is ActionPlanItem => Boolean(entry))
    : [];

  return { summary, language, rawText, risks, actionItems };
};

const buildFallbackInsightBundle = (
  product: ForecastProduct,
  context: ReturnType<typeof buildInsightContext>,
): {
  insight: {
    summary: string;
    drivers: string[];
    watchouts: string[];
    risks: Array<{
      id: string;
      side: 'upside' | 'downside';
      driver: string;
      evidence: string;
      impact: 'high' | 'medium' | 'low';
      confidence: number;
    }>;
    generatedAt: string;
    source: 'fallback';
  };
  actionItems: ActionPlanItem[];
} => {
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

  const risks: Array<{
    id: string;
    side: 'upside' | 'downside';
    driver: string;
    evidence: string;
    impact: 'high' | 'medium' | 'low';
    confidence: number;
  }> = [];

  if (available < safetyStockValue) {
    risks.push({
      id: 'risk-stockout',
      side: 'downside',
      driver: '안전재고 미만',
      evidence: `가용 ${formatNumber(available)}개 < 안전재고 ${formatNumber(safetyStockValue)}개`,
      impact: 'high',
      confidence: 0.78,
    });
  } else {
    risks.push({
      id: 'risk-coverage',
      side: 'upside',
      driver: '재고 여유',
      evidence: `가용 ${formatNumber(available)}개가 안전재고 대비 ${(available / Math.max(safetyStockValue || 1, 1)).toFixed(1)}배 수준`,
      impact: 'medium',
      confidence: 0.65,
    });
  }

  if (typeof metrics?.projectedStockoutDate === 'string' && metrics.projectedStockoutDate) {
    risks.push({
      id: 'risk-stockout-date',
      side: 'downside',
      driver: '재고 소진 예상',
      evidence: `예상 소진일 ${metrics.projectedStockoutDate}`,
      impact: 'high',
      confidence: 0.72,
    });
  }

  const today = new Date();
  const actionWindow = new Date(today);
  actionWindow.setDate(today.getDate() + 7);
  const actionWindowLabel = formatDateLabel(actionWindow.toISOString().slice(0, 10));

  const actionItems: ActionPlanItem[] = [];
  if (available < safetyStockValue) {
    actionItems.push({
      id: 'fallback-replenish',
      who: '영업기획팀',
      what: `${formatNumber(metrics?.recommendedOrderQty ?? safetyStockValue - available)}개 발주 확정`,
      when: actionWindowLabel,
      rationale: '안전재고 이하 구간 진입으로 긴급 보충 필요',
      confidence: 0.75,
      kpi: {
        name: '서비스레벨',
        target: '>=95%',
        window: '향후 4주',
      },
    });
  } else {
    actionItems.push({
      id: 'fallback-optimize',
      who: '마케팅팀',
      what: '과잉 재고 분산 프로모션 기획',
      when: actionWindowLabel,
      rationale: '안전재고 대비 재고 여유가 커서 수요 창출 필요',
      confidence: 0.62,
      kpi: {
        name: 'DOS',
        target: '<=30일',
        window: '향후 8주',
      },
    });
  }

  actionItems.push({
    id: 'fallback-check',
    who: '공급망팀',
    what: '리드타임 재점검 및 공급 제약 확인',
    when: actionWindowLabel,
    rationale: '재고 변동성을 줄이기 위해 리드타임 가정 검증',
    confidence: 0.58,
    kpi: {
      name: '리드타임 편차',
      target: '<=2일',
      window: '분기',
    },
  });

  return {
    insight: {
      summary: summaryParts.join(' '),
      drivers,
      watchouts,
      risks,
      generatedAt: new Date().toISOString(),
      source: 'fallback',
      version: 'v1',
    },
    actionItems,
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
      const fallback = buildFallbackInsightBundle(product, context);
      const actionPlan = saveActionPlan({
        sku: product.sku,
        productId: product.id,
        items: fallback.actionItems,
        source: 'manual',
        createdBy: 'system',
        language: 'ko',
        version: 'v1',
      });
      return reply.send({
        insight: { ...fallback.insight, language: 'ko', version: 'v1' },
        actionPlan,
        error: 'LLM 분석 기능이 활성화되지 않아 기본 인사이트를 제공합니다.',
      });
    }

    try {
      const completion = await insightsClient.chat.completions.create({
        model: OPENAI_CHAT_MODEL,
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
      const driverBullets =
        parsed.risks.length > 0
          ? parsed.risks.map(
              (risk) =>
                `${risk.side === 'downside' ? 'Downside' : 'Upside'} · ${risk.driver}: ${risk.evidence}`,
            )
          : [];
      const watchouts =
        parsed.risks.length > 0
          ? parsed.risks
              .filter((risk) => risk.side === 'downside')
              .map((risk) => `${risk.driver}: ${risk.evidence}`)
          : [];

      const insight = {
        summary: parsed.summary || '생성된 요약이 없습니다.',
        drivers: driverBullets,
        watchouts,
        risks: parsed.risks,
        generatedAt: new Date().toISOString(),
        source: 'llm' as const,
        rawText: parsed.rawText,
        language: parsed.language ?? 'ko',
        version: 'v1',
      };

      let actionItems = parsed.actionItems;
      if (actionItems.length === 0) {
        const fallback = buildFallbackInsightBundle(product, context);
        actionItems = fallback.actionItems;
      }

      const actionPlan =
        actionItems.length > 0
          ? saveActionPlan({
              sku: product.sku,
              productId: product.id,
              items: actionItems,
              source: 'llm',
              createdBy: 'llm-agent',
              language: parsed.language ?? 'ko',
              version: 'v1',
            })
          : null;

      return reply.send({ insight, actionPlan });
    } catch (error) {
      request.log.error(error, 'Failed to generate forecast insight');
      const fallback = buildFallbackInsightBundle(product, context);
      const actionPlan = saveActionPlan({
        sku: product.sku,
        productId: product.id,
        items: fallback.actionItems,
        source: 'manual',
        createdBy: 'system',
        language: 'ko',
        version: 'v1',
      });
      const status = extractHttpStatus(error);
      const message =
        status === 401 || status === 403
          ? 'LLM 인증 정보를 확인해주세요. 기본 인사이트를 제공합니다.'
          : 'LLM 분석을 생성하지 못해 기본 인사이트를 제공합니다.';
      return reply.send({
        insight: { ...fallback.insight, language: 'ko', version: 'v1' },
        actionPlan,
        error: message,
      });
    }
  });
}
