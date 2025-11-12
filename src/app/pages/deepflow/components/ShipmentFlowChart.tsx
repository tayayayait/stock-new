import * as React from 'react';
import { use as registerECharts, init, getInstanceByDom, type EChartsType, type SetOptionOpts } from 'echarts/core';
import type { ComposeOption } from 'echarts/core';
import type { BarSeriesOption, LineSeriesOption } from 'echarts/charts';
import { BarChart, LineChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  AxisPointerComponent,
  type GridComponentOption,
  type LegendComponentOption,
  type TooltipComponentOption,
  type AxisPointerComponentOption,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

registerECharts([
  BarChart,
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);

type ShipmentFlowChartOption = ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | GridComponentOption
  | LegendComponentOption
  | TooltipComponentOption
  | AxisPointerComponentOption
>;

export interface ShipmentFlowChartPoint {
  monthLabel: string;
  total: number;
  mom: number | null;
  yoy: number | null;
  [category: string]: number | string | null | undefined;
}

const COLORS = {
  background: 'transparent',
  gridLine: '#E2E8F0',
  axisText: '#475569',
  legendText: '#0F172A',
  tooltipBackground: '#0f172a',
  tooltipText: '#F8FAFC',
  tooltipBorder: '#1F2937',
  tooltipHint: 'rgba(248,250,252,0.8)',
  momLine: '#f97316',
  yoyLine: '#22c55e',
};
const LEGEND_ICONS = {
  dashedLine: 'path://M0,6 L10,6 M14,6 L24,6 M28,6 L38,6',
};

const formattedNumber = (value: number) => value.toLocaleString('ko-KR');
const formattedPercent = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}%`;

interface ShipmentFlowChartProps {
  data: ShipmentFlowChartPoint[];
  categories: string[];
  palette: string[];
  momAvailable: boolean;
  yoyAvailable: boolean;
  unitLabel?: string;
}

const TOP_TOOLTIP_MAX_HEIGHT = 280;

const ShipmentFlowChart: React.FC<ShipmentFlowChartProps> = ({
  data,
  categories,
  palette,
  momAvailable,
  yoyAvailable,
  unitLabel,
}) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<EChartsType | null>(null);

  const chartOption = React.useMemo<ShipmentFlowChartOption>(() => {
    const categorySeries = categories.map((category, index) => ({
      name: category,
      type: 'bar',
      stack: 'shipments',
      emphasis: { focus: 'series' as const },
      itemStyle: {
        color: palette[index % palette.length],
      },
      data: data.map((point) => (typeof point[category] === 'number' ? point[category] : 0)),
      barMaxWidth: 36,
      showBackground: false,
    } as BarSeriesOption));

    const lineSeries: LineSeriesOption[] = [];
    if (momAvailable) {
      lineSeries.push({
        name: 'MoM',
        type: 'line',
        data: data.map((point) => (typeof point.mom === 'number' ? point.mom : null)),
        yAxisIndex: 1,
        smooth: true,
        showSymbol: false,
        color: COLORS.momLine,
        legendIcon: 'line',
        lineStyle: {
          color: COLORS.momLine,
          width: 2.5,
          type: 'solid',
        },
        emphasis: { focus: 'series' },
      });
    }
    if (yoyAvailable) {
      lineSeries.push({
        name: 'YoY',
        type: 'line',
        data: data.map((point) => (typeof point.yoy === 'number' ? point.yoy : null)),
        yAxisIndex: 1,
        smooth: true,
        showSymbol: false,
        color: COLORS.yoyLine,
        legendIcon: LEGEND_ICONS.dashedLine,
        lineStyle: {
          color: COLORS.yoyLine,
          width: 2.5,
          type: 'dashed',
        },
        emphasis: { focus: 'series' },
      });
    }

    const tooltipFormatter = (params: any[]) => {
      if (!Array.isArray(params) || params.length === 0) {
        return '';
      }
      const targetMonth = params[0]?.axisValueLabel ?? params[0]?.axisValue ?? '';
      const barItems = params.filter((item) => item.seriesType === 'bar');
      const sortedBars = [...barItems].sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0));
      const momItem = params.find((item) => item.seriesName === 'MoM');
      const yoyItem = params.find((item) => item.seriesName === 'YoY');
      const numberSuffix = unitLabel ? ` ${unitLabel}` : '';
      let html = `<div style="display:flex;flex-direction:column;gap:8px;min-width:220px;">`;
      html += `<div style="font-weight:600;color:${COLORS.tooltipText};font-size:14px;">${targetMonth}</div>`;
      html += `<div style="display:flex;gap:12px;font-size:12px;color:${COLORS.tooltipHint};">`;
      if (momAvailable) {
        html += `<span style="color:${COLORS.tooltipText};font-weight:600;">MoM ${formattedPercent(momItem?.value ?? null)}</span>`;
      }
      if (yoyAvailable) {
        html += `<span style="color:${COLORS.tooltipText};font-weight:600;">YoY ${formattedPercent(yoyItem?.value ?? null)}</span>`;
      }
      html += `</div>`;
      sortedBars.forEach((entry) => {
        const value = Number(entry.value ?? 0);
        html += `<div style="display:flex;justify-content:space-between;gap:12px;font-size:12px;color:${COLORS.tooltipText};">`;
        html += `<span style="display:flex;align-items:center;gap:6px;">`;
        const markerColor = entry.color ?? entry.borderColor ?? '#cbd5f5';
        html += `<span style="width:8px;height:8px;border-radius:999px;background:${markerColor};display:inline-block;"></span>`;
        html += `<span>${entry.seriesName}</span>`;
        html += `</span>`;
        html += `<span style="font-weight:600;">${formattedNumber(value)}${numberSuffix}</span>`;
        html += `</div>`;
      });
      html += `</div>`;
      return html;
    };

    return {
      backgroundColor: COLORS.background,
      grid: {
        top: 48,
        right: 140,
        left: 42,
        bottom: 42,
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'shadow',
        },
        confine: true,
        appendToBody: true,
        extraCssText: `max-height:${TOP_TOOLTIP_MAX_HEIGHT}px;overflow:auto;padding-right:8px;border-radius:8px;`,
        backgroundColor: COLORS.tooltipBackground,
        borderColor: COLORS.tooltipBorder,
        borderWidth: 1,
        textStyle: {
          color: COLORS.tooltipText,
          fontSize: 12,
        },
        formatter: tooltipFormatter,
      },
      legend: {
        orient: 'vertical',
        right: 8,
        top: 16,
        bottom: 16,
        align: 'left',
        itemGap: 8,
        textStyle: {
          color: COLORS.legendText,
          fontSize: 12,
          fontWeight: 500,
        },
        icon: 'rect',
      },
      xAxis: {
        type: 'category',
        data: data.map((point) => point.monthLabel),
        axisLine: {
          lineStyle: {
            color: COLORS.gridLine,
            width: 1,
          },
        },
        axisTick: { show: false },
        axisLabel: {
          color: COLORS.axisText,
          fontSize: 11,
          margin: 10,
        },
      },
      yAxis: [
        {
          type: 'value',
          name: '출고량',
          position: 'left',
          axisLine: { show: false },
          axisTick: { show: false },
          nameTextStyle: {
            color: COLORS.axisText,
          },
          axisLabel: {
            color: COLORS.axisText,
            fontSize: 11,
            formatter: (value: number | string) => {
              const numeric = typeof value === 'number' ? value : Number(value);
              if (!Number.isFinite(numeric)) {
                return '';
              }
              return formattedNumber(numeric);
            },
          },
          splitLine: {
            show: true,
            lineStyle: {
              color: COLORS.gridLine,
              type: 'dashed',
              width: 1,
            },
          },
        },
        {
          type: 'value',
          name: '증감(%)',
          position: 'right',
          min: -200,
          max: 400,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            formatter: '{value}%',
            color: COLORS.axisText,
            fontSize: 11,
          },
          splitLine: { show: false },
        },
      ],
      series: [...categorySeries, ...lineSeries],
    };
  }, [categories, data, momAvailable, palette, unitLabel, yoyAvailable]);

  React.useEffect(() => {
    const dom = containerRef.current;
    if (!dom) {
      return;
    }
    let chartInstance = getInstanceByDom(dom);
    if (!chartInstance) {
      chartInstance = init(dom, undefined, { renderer: 'canvas' });
    }
    chartRef.current = chartInstance;

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        chartInstance?.resize();
      });
      resizeObserver.observe(dom);
    } else {
      const handleResize = () => {
        chartInstance?.resize();
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
    if (!chartRef.current) {
      return;
    }
    const opts: SetOptionOpts = { notMerge: true, lazyUpdate: false };
    chartRef.current.setOption(chartOption, opts);
  }, [chartOption]);

  return (
    <div className="h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
};

export default ShipmentFlowChart;
