import * as React from 'react';
import type { CSSProperties } from 'react';
import {
  use as registerECharts,
  init,
  getInstanceByDom,
  type EChartsType,
  type SetOptionOpts,
} from 'echarts/core';
import type { ComposeOption } from 'echarts/core';
import type { LineSeriesOption } from 'echarts/charts';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  MarkAreaComponent,
  MarkLineComponent,
  DataZoomComponent,
  AxisPointerComponent,
  type GridComponentOption,
  type LegendComponentOption,
  type TooltipComponentOption,
  type MarkAreaComponentOption,
  type MarkLineComponentOption,
  type DataZoomComponentOption,
  type AxisPointerComponentOption,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

registerECharts([
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  MarkAreaComponent,
  MarkLineComponent,
  DataZoomComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);

type ForecastEChartsOption = ComposeOption<
  | LineSeriesOption
  | GridComponentOption
  | LegendComponentOption
  | TooltipComponentOption
  | MarkAreaComponentOption
  | MarkLineComponentOption
  | DataZoomComponentOption
  | AxisPointerComponentOption
>;

export interface ForecastChartPoint {
  ts?: number;
  date?: string;
  isoDate?: string;
  actual?: number | null;
  value?: number | null;
  fc?: number | null;
  forecast?: number | null;
  phase?: 'history' | 'forecast';
  isFinal?: boolean | null;
  promo?: boolean;
  [key: string]: unknown;
}

export interface ForecastRange {
  start: string;
  end: string;
}

interface ForecastChartProps {
  data: ForecastChartPoint[];
  forecastRange?: ForecastRange | null;
  loading?: boolean;
  error?: string | null;
  unitLabel?: string;
  /**
   * 강제로 오늘 데이터를 예측 구간으로 취급하고 싶을 때 사용합니다.
   * undefined 이면 자동 판정(18시 이전 => 예측, 이후 => 실적)을 따릅니다.
   */
  includeTodayAsForecast?: boolean;
  className?: string;
  style?: CSSProperties;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const;

// NOTE:
// The initial palette was optimized for a dark background, which made the
// chart effectively invisible on this app’s light UI (white card background).
// Update colors to a light-theme friendly palette so axes, grid and lines are
// clearly visible.
const COLORS = {
  // Lines
  actualLine: '#0F172A', // slate-900
  actualShadow: 'rgba(15,23,42,0.25)',
  forecastLine: '#3B82F6', // primary-500
  forecastFill: 'rgba(59,130,246,0.15)',
  todayLine: '#94A3B8', // slate-400

  // Axes & grid
  axisText: '#475569', // slate-600
  gridLine: '#E2E8F0', // slate-200
  legendText: '#334155', // slate-700

  // Tooltip
  tooltipBackground: 'rgba(15,23,42,0.92)',
  tooltipBorder: '#1f2937',
  tooltipText: '#F8FAFC',
} as const;

interface NormalizedPoint {
  ts: number;
  actualValue: number | null;
  forecastValue: number | null;
  isForecast: boolean;
  axisLabel: string;
  tooltipDate: string;
  weekdayLabel: string;
  displayValue: number | null;
}

interface NormalizationResult {
  points: NormalizedPoint[];
  metaByKey: Map<string, NormalizedPoint>;
  todayStart: number;
  markAreaStart: number | null;
  markAreaEnd: number | null;
  zoomStart: number | null;
  zoomEnd: number | null;
  lastTs: number | null;
  domainMin: number;
  domainMax: number;
  sampling: boolean;
}

type SeriesDataItem = {
  value: [number, number | null];
  meta: NormalizedPoint;
};

const pad2 = (value: number): string => (value < 10 ? `0${value}` : String(value));

const alignToKstStartOfDay = (timestamp: number): number => {
  const dayIndex = Math.floor((timestamp + KST_OFFSET_MS) / DAY_MS);
  return dayIndex * DAY_MS - KST_OFFSET_MS;
};

const extractKstParts = (timestamp: number) => {
  const adjusted = timestamp + KST_OFFSET_MS;
  const date = new Date(adjusted);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const parseEpoch = (input: unknown): number | null => {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }
    if (/^\d+$/.test(trimmed)) {
      const parsedNumber = Number(trimmed);
      return Number.isFinite(parsedNumber) ? parsedNumber : null;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const [y, m, d] = trimmed.split('-').map((segment) => Number.parseInt(segment, 10));
      if ([y, m, d].every((segment) => Number.isFinite(segment))) {
        return Date.UTC(y, (m ?? 1) - 1, d ?? 1) - KST_OFFSET_MS;
      }
    }
    if (/^\d{4}-\d{2}$/.test(trimmed)) {
      const [y, m] = trimmed.split('-').map((segment) => Number.parseInt(segment, 10));
      if ([y, m].every((segment) => Number.isFinite(segment))) {
        return Date.UTC(y, (m ?? 1) - 1, 1) - KST_OFFSET_MS;
      }
    }
    if (/^\d{2}-\d{2}$/.test(trimmed)) {
      const [yy, mm] = trimmed.split('-').map((segment) => Number.parseInt(segment, 10));
      if ([yy, mm].every((segment) => Number.isFinite(segment))) {
        const fullYear = yy >= 70 ? 1900 + yy : 2000 + yy;
        return Date.UTC(fullYear, (mm ?? 1) - 1, 1) - KST_OFFSET_MS;
      }
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const parseRangePoint = (value: string | undefined | null): number | null => {
  if (!value) {
    return null;
  }
  const parsed = parseEpoch(value);
  return parsed === null ? null : alignToKstStartOfDay(parsed);
};

const normalizeData = (
  raw: ForecastChartPoint[],
  forecastRange: ForecastRange | null | undefined,
  includeTodayAsForecast: boolean | undefined,
): NormalizationResult => {
  const mergedByTimestamp = new Map<
    number,
    { actual: number | null; forecast: number | null; phase?: 'history' | 'forecast'; isFinal?: boolean | null }
  >();

  raw.forEach((point) => {
    const epochCandidate =
      parseEpoch(point.ts) ??
      parseEpoch(point.isoDate) ??
      parseEpoch(point.date);

    if (epochCandidate === null || Number.isNaN(epochCandidate)) {
      return;
    }

    const ts = alignToKstStartOfDay(epochCandidate);
    const previous = mergedByTimestamp.get(ts);

    const actualCandidates: Array<number | null | undefined> = [
      point.actual,
      point.value,
      previous?.actual ?? null,
    ];
    const forecastCandidates: Array<number | null | undefined> = [
      point.fc,
      point.forecast,
      point.value,
      previous?.forecast ?? null,
    ];

    const actualValue =
      actualCandidates.find(isFiniteNumber) ?? (previous?.actual ?? null);
    const forecastValue =
      forecastCandidates.find(isFiniteNumber) ?? (previous?.forecast ?? null);

    mergedByTimestamp.set(ts, {
      actual: isFiniteNumber(actualValue) ? actualValue : null,
      forecast: isFiniteNumber(forecastValue) ? forecastValue : null,
      phase: point.phase ?? previous?.phase,
      isFinal:
        typeof point.isFinal === 'boolean'
          ? point.isFinal
          : previous?.isFinal,
    });
  });

  const entries = Array.from(mergedByTimestamp.entries())
    .map(([ts, value]) => ({ ts, ...value }))
    .sort((a, b) => a.ts - b.ts);

  const nowUtc = Date.now();
  const todayStart = alignToKstStartOfDay(nowUtc);
  const cutoffUtc = todayStart + 18 * 60 * 60 * 1000;

  const todayEntry = entries.find((entry) => entry.ts === todayStart);

  let includeToday = includeTodayAsForecast;
  if (includeToday === undefined) {
    if (todayEntry) {
      if (todayEntry.phase === 'forecast') {
        includeToday = true;
      } else if (todayEntry.phase === 'history') {
        includeToday = false;
      } else if (typeof todayEntry.isFinal === 'boolean') {
        includeToday = !todayEntry.isFinal;
      }
    }
  }

  if (includeToday === undefined) {
    includeToday = nowUtc < cutoffUtc;
  }

  const rangeStart = parseRangePoint(forecastRange?.start);
  const rangeEnd = parseRangePoint(forecastRange?.end);

  const normalizedPoints: NormalizedPoint[] = [];
  const metaByKey = new Map<string, NormalizedPoint>();

  let inferredForecastStart: number | null = null;
  let lastForecastTs: number | null = null;
  let lastTs: number | null = null;

  entries.forEach((entry) => {
    const { ts, actual, forecast, phase, isFinal } = entry;
    let isForecast: boolean;
    if (phase === 'forecast') {
      isForecast = true;
    } else if (phase === 'history') {
      isForecast = false;
    } else if (typeof isFinal === 'boolean') {
      isForecast = !isFinal;
    } else if (ts < todayStart) {
      isForecast = false;
    } else if (ts > todayStart) {
      isForecast = true;
    } else {
      isForecast = includeToday ?? true;
    }

    if (isForecast && inferredForecastStart === null) {
      inferredForecastStart = ts;
    }
    if (isForecast) {
      lastForecastTs = ts;
    }

    const actualValue = isFiniteNumber(actual) ? actual : null;
    const forecastValue = isFiniteNumber(forecast) ? forecast : null;
    const displayValue = isForecast ? forecastValue ?? actualValue : actualValue;

    const parts = extractKstParts(ts);
    const axisLabel = `${pad2(parts.month)}/${pad2(parts.day)}`;
    const tooltipDate = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
    const weekdayLabel = WEEKDAY_LABELS[parts.weekday] ?? '';

    const normalizedPoint: NormalizedPoint = {
      ts,
      actualValue,
      forecastValue,
      isForecast,
      axisLabel,
      tooltipDate,
      weekdayLabel,
      displayValue,
    };

    normalizedPoints.push(normalizedPoint);
    metaByKey.set(String(ts), normalizedPoint);
    lastTs = ts;
  });

  let domainMin = todayStart;
  let domainMax = todayStart;

  if (normalizedPoints.length > 0) {
    const firstTs = normalizedPoints[0].ts;
    domainMin = Math.min(firstTs, todayStart);
    domainMax = Math.max(normalizedPoints[normalizedPoints.length - 1].ts, todayStart);
  }

  const clampToDomain = (value: number): number => {
    if (value < domainMin) {
      return domainMin;
    }
    if (value > domainMax) {
      return domainMax;
    }
    return value;
  };

  let markAreaStart: number | null = null;
  let markAreaEnd: number | null = null;

  const defaultForecastStart = includeToday ? todayStart : todayStart + DAY_MS;
  const defaultForecastEnd =
    lastForecastTs ??
    lastTs ??
    (includeToday ? todayStart : todayStart + DAY_MS);

  let markAreaStartCandidate =
    rangeStart !== null ? rangeStart : (inferredForecastStart ?? defaultForecastStart);
  let markAreaEndCandidate =
    rangeEnd !== null ? rangeEnd : defaultForecastEnd;

  markAreaStartCandidate = clampToDomain(markAreaStartCandidate);
  markAreaEndCandidate = clampToDomain(markAreaEndCandidate);

  if (markAreaEndCandidate > markAreaStartCandidate) {
    markAreaStart = markAreaStartCandidate;
    markAreaEnd = markAreaEndCandidate;
  } else {
    markAreaStart = null;
    markAreaEnd = null;
  }

  const ninetyDaysMs = 89 * DAY_MS;
  const latestDataTs = lastTs ?? todayStart;

  let zoomEnd = todayStart;
  let zoomStart = Math.max(domainMin, zoomEnd - ninetyDaysMs);

  if (latestDataTs > zoomEnd) {
    zoomEnd = latestDataTs;
    zoomStart = Math.max(domainMin, zoomEnd - ninetyDaysMs);
  }

  if (latestDataTs < zoomStart) {
    zoomEnd = latestDataTs;
    zoomStart = Math.max(domainMin, zoomEnd - ninetyDaysMs);
  }

  if (zoomEnd < domainMin) {
    zoomEnd = domainMin;
  }
  if (zoomStart > zoomEnd) {
    zoomStart = domainMin;
  }

  if (normalizedPoints.length === 0 || lastTs === null) {
    return {
      points: [],
      metaByKey,
      todayStart,
      markAreaStart,
      markAreaEnd,
      zoomStart,
      zoomEnd,
      lastTs: null,
      domainMin,
      domainMax,
      sampling: false,
    };
  }

  return {
    points: normalizedPoints,
    metaByKey,
    todayStart,
    markAreaStart,
    markAreaEnd,
    zoomStart,
    zoomEnd,
    lastTs,
    domainMin,
    domainMax,
    sampling: normalizedPoints.length > 5000,
  };
};

const formatAxisLabel = (value: number | string): string => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return '';
  }
  const parts = extractKstParts(numeric);
  return `${pad2(parts.month)}/${pad2(parts.day)}`;
};

const ForecastChart: React.FC<ForecastChartProps> = ({
  data,
  forecastRange = null,
  loading = false,
  error = null,
  unitLabel = 'EA',
  includeTodayAsForecast,
  className,
  style,
}) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<EChartsType | null>(null);

  const numberFormatter = React.useMemo(
    () =>
      new Intl.NumberFormat('ko-KR', {
        maximumFractionDigits: 0,
      }),
    [],
  );

  const normalized = React.useMemo(
    () => normalizeData(data, forecastRange, includeTodayAsForecast),
    [data, forecastRange, includeTodayAsForecast],
  );

  const hasRenderableData = normalized.points.some(
    (point) => point.actualValue !== null || point.forecastValue !== null,
  );

  const chartOption = React.useMemo<ForecastEChartsOption | null>(() => {
    if (!hasRenderableData || normalized.points.length === 0 || normalized.lastTs === null) {
      return null;
    }

    const actualSeries: SeriesDataItem[] = normalized.points.map((point) => ({
      value: [point.ts, point.isForecast ? null : point.actualValue],
      meta: point,
    }));

    const forecastSeries: SeriesDataItem[] = normalized.points.map((point) => ({
      value: [point.ts, point.isForecast ? point.forecastValue ?? point.actualValue ?? null : null],
      meta: point,
    }));

    const hasZoomWindow =
      normalized.zoomStart !== null &&
      normalized.zoomEnd !== null &&
      normalized.zoomEnd > normalized.zoomStart;

    const dataZoom = hasZoomWindow
      ? ([
            {
              type: 'inside',
              startValue: normalized.zoomStart,
              endValue: normalized.zoomEnd,
              filterMode: 'filter',
              minValueSpan: DAY_MS,
            },
            {
              type: 'slider',
              startValue: normalized.zoomStart,
              endValue: normalized.zoomEnd,
              filterMode: 'filter',
              height: 26,
              bottom: 18,
              borderColor: 'rgba(30,41,59,0.8)',
              backgroundColor: 'rgba(15,23,42,0.45)',
              dataBackground: {
                lineStyle: { color: COLORS.forecastLine, width: 1 },
                areaStyle: { color: 'rgba(168,199,255,0.14)' },
              },
              fillerColor: 'rgba(168,199,255,0.2)',
              handleStyle: {
                color: COLORS.forecastLine,
                borderColor: '#D9E4FF',
              },
              textStyle: {
                color: COLORS.axisText,
              },
            },
          ] as DataZoomComponentOption[])
      : undefined;

    const markAreaData =
      normalized.markAreaStart !== null && normalized.markAreaEnd !== null
        ? [
            [
              { xAxis: normalized.markAreaStart },
              {
                xAxis:
                  normalized.markAreaEnd === normalized.markAreaStart
                    ? normalized.markAreaEnd + DAY_MS
                    : normalized.markAreaEnd,
              },
            ],
          ]
        : undefined;

    const markLineData =
      normalized.todayStart !== null
        ? [
            {
              xAxis: normalized.todayStart,
            },
          ]
        : undefined;

    const tooltipFormatter = (params: any[]): string => {
      if (!Array.isArray(params) || params.length === 0) {
        return '';
      }

      const candidateWithMeta = params.find(
        (entry) => entry && entry.data && typeof entry.data === 'object' && 'meta' in entry.data,
      ) as { data?: SeriesDataItem } | undefined;

      const axisValueRaw = params[0]?.axisValue;
      const axisValueNumeric =
        typeof axisValueRaw === 'number'
          ? axisValueRaw
          : typeof axisValueRaw === 'string'
            ? Number(axisValueRaw)
            : Number.NaN;

      const meta =
        candidateWithMeta?.data?.meta ??
        (Number.isFinite(axisValueNumeric)
          ? normalized.metaByKey.get(String(axisValueNumeric))
          : undefined);

      if (!meta) {
        return '';
      }

      const badgeText = meta.isForecast ? '예측 구간' : '실제 구간';
      const badgeColor = meta.isForecast ? 'rgba(168,199,255,0.18)' : 'rgba(255,255,255,0.16)';
      const badgeBorder = meta.isForecast ? 'rgba(168,199,255,0.35)' : 'rgba(255,255,255,0.25)';
      const badgeTextColor = meta.isForecast ? COLORS.forecastLine : COLORS.actualLine;

      const actualText =
        meta.actualValue === null
          ? '—'
          : `${numberFormatter.format(meta.actualValue)}${unitLabel ? ` ${unitLabel}` : ''}`;
      const forecastText =
        meta.forecastValue === null
          ? '—'
          : `${numberFormatter.format(meta.forecastValue)}${unitLabel ? ` ${unitLabel}` : ''}`;

      const rows: string[] = [
        `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">` +
          `<span style="display:flex;align-items:center;gap:6px;color:${COLORS.tooltipText};">` +
          `<span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${COLORS.actualLine};box-shadow:0 0 4px rgba(255,255,255,0.65);"></span>` +
          `실제 출고량</span>` +
          `<span style="font-weight:600;color:${COLORS.tooltipText};">${actualText}</span>` +
          `</div>`,
        `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">` +
          `<span style="display:flex;align-items:center;gap:6px;color:${COLORS.tooltipText};">` +
          `<span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${COLORS.forecastLine};"></span>` +
          `예측 출고량</span>` +
          `<span style="font-weight:600;color:${COLORS.tooltipText};">${forecastText}</span>` +
          `</div>`,
      ];

      return [
        `<div style="display:flex;flex-direction:column;gap:8px;min-width:220px;">`,
        `<div style="font-weight:600;color:${COLORS.tooltipText};font-size:13px;">${meta.tooltipDate} (${meta.weekdayLabel})</div>`,
        `<div style="display:inline-flex;align-items:center;padding:2px 8px;font-size:10px;border-radius:9999px;border:1px solid ${badgeBorder};color:${badgeTextColor};background:${badgeColor};font-weight:600;width:flex-start;">${badgeText}</div>`,
        `<div style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:${COLORS.tooltipText};">`,
        rows.join(''),
        `</div>`,
        `</div>`,
      ].join('');
    };

    return {
      backgroundColor: 'transparent',
      grid: {
        top: 38,
        left: 58,
        right: 26,
        bottom: dataZoom ? 86 : 46,
      },
      legend: {
        data: ['실제 출고량(하얀색)', '예측 출고량(연한 파랑)'],
        top: 2,
        left: 4,
        itemWidth: 14,
        itemHeight: 4,
        textStyle: {
          color: COLORS.legendText,
          fontWeight: 500,
          fontSize: 12,
        },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: COLORS.tooltipBackground,
        borderColor: COLORS.tooltipBorder,
        borderWidth: 1,
        textStyle: {
          color: COLORS.tooltipText,
          fontSize: 12,
        },
        axisPointer: {
          type: 'line',
          lineStyle: {
            color: COLORS.forecastLine,
            type: 'dashed',
            width: 1,
          },
        },
        appendToBody: true,
        formatter: tooltipFormatter,
      },
      xAxis: {
        type: 'time',
        min: normalized.domainMin,
        max: normalized.domainMax,
        axisLine: {
          lineStyle: {
            color: COLORS.gridLine,
            width: 1,
          },
        },
        splitLine: {
          show: true,
          lineStyle: {
            color: COLORS.gridLine,
            width: 1,
            type: 'dashed',
          },
        },
        axisLabel: {
          color: COLORS.axisText,
          fontSize: 11,
          margin: 14,
          formatter: (value: number | string) => {
            const meta = normalized.metaByKey.get(String(value));
            return meta?.axisLabel ?? formatAxisLabel(value);
          },
        },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: {
          show: true,
          lineStyle: {
            color: COLORS.gridLine,
            width: 1,
            type: 'dashed',
          },
        },
        axisLabel: {
          color: COLORS.axisText,
          fontSize: 11,
          formatter: (value: number | string) => {
            const numeric = typeof value === 'number' ? value : Number(value);
            if (!Number.isFinite(numeric)) {
              return '';
            }
            return numberFormatter.format(numeric);
          },
        },
      },
      dataZoom,
      series: [
        {
          name: '실제 출고량(하얀색)',
          type: 'line',
          showSymbol: false,
          connectNulls: false,
          smooth: false,
          symbolSize: 6,
          lineStyle: {
            color: COLORS.actualLine,
            width: 2.5,
            shadowBlur: 8,
            shadowColor: COLORS.actualShadow,
          },
          itemStyle: {
            color: COLORS.actualLine,
          },
          emphasis: {
            focus: 'series',
          },
          sampling: normalized.sampling ? 'lttb' : undefined,
          data: actualSeries,
          zlevel: 3,
          z: 4,
        } as LineSeriesOption,
        {
          name: '예측 출고량(연한 파랑)',
          type: 'line',
          showSymbol: false,
          connectNulls: false,
          smooth: false,
          symbolSize: 6,
          lineStyle: {
            color: COLORS.forecastLine,
            width: 2.5,
            type: 'dashed',
          },
          itemStyle: {
            color: COLORS.forecastLine,
          },
          emphasis: {
            focus: 'series',
          },
          sampling: normalized.sampling ? 'lttb' : undefined,
          data: forecastSeries,
          markArea: markAreaData
            ? {
                silent: true,
                itemStyle: {
                  color: COLORS.forecastFill,
                },
                data: markAreaData,
                emphasis: {
                  disabled: true,
                },
                z: 1,
              }
            : undefined,
          markLine: markLineData
            ? {
                symbol: 'none',
                silent: true,
                lineStyle: {
                  color: COLORS.todayLine,
                  type: 'dashed',
                  width: 1.5,
                },
                label: { show: false },
                data: markLineData,
                emphasis: {
                  disabled: true,
                },
                z: 5,
              }
            : undefined,
          zlevel: 2,
          z: 3,
        } as LineSeriesOption,
      ],
    };
  }, [hasRenderableData, normalized, numberFormatter, unitLabel]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let chart = getInstanceByDom(container);
    if (!chart) {
      chart = init(container, undefined, { renderer: 'canvas' });
    }
    chartRef.current = chart;

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        chart?.resize();
      });
      resizeObserver.observe(container);
    } else {
      const handleResize = () => {
        chart?.resize();
      };
      window.addEventListener('resize', handleResize);
      return () => {
        window.removeEventListener('resize', handleResize);
        if (resizeObserver) {
          resizeObserver.disconnect();
        }
        if (chartRef.current) {
          chartRef.current.dispose();
          chartRef.current = null;
        }
      };
    }

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (chartRef.current) {
        chartRef.current.dispose();
        chartRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    if (!chartRef.current || !chartOption) {
      return;
    }

    const setOptionOpts: SetOptionOpts = { notMerge: true, lazyUpdate: false };
    chartRef.current.setOption(chartOption, setOptionOpts);
  }, [chartOption]);

  React.useEffect(() => {
    if (!hasRenderableData && chartRef.current) {
      chartRef.current.dispose();
      chartRef.current = null;
    }
  }, [hasRenderableData]);

  if (loading) {
    return (
      <div className="flex h-80 items-center justify-center text-sm text-slate-400">
        선택한 품목의 예측 데이터를 불러오는 중입니다...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-80 items-center justify-center px-6 text-center text-sm text-rose-400">
        {error}
      </div>
    );
  }

  if (!hasRenderableData) {
    return (
      <div className="flex h-80 items-center justify-center text-sm text-slate-400">
        표시할 예측 데이터를 찾을 수 없습니다.
      </div>
    );
  }

  return (
    <div className={`h-80 ${className ?? ''}`} style={style}>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
};

export default ForecastChart;
