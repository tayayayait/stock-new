import * as React from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TooltipProps } from 'recharts';

export interface ForecastChartPoint {
  date: string;
  isoDate?: string;
  phase?: 'history' | 'forecast';
  [key: string]: string | number | null | undefined;
}

export interface ForecastChartLine {
  key: string;
  name: string;
  color?: string;
  strokeDasharray?: string;
}

export interface ForecastRange {
  start: string;
  end: string;
}

interface ForecastChartProps {
  data: ForecastChartPoint[];
  lines: ForecastChartLine[];
  colors?: string[];
  forecastRange?: ForecastRange | null;
  loading?: boolean;
  error?: string | null;
}

const DEFAULT_COLORS = ['#0ea5e9', '#6366f1', '#f97316', '#22c55e', '#ec4899', '#14b8a6'];

const ForecastTooltip: React.FC<
  TooltipProps<number, string> & { lineMap: Record<string, ForecastChartLine> }
> = ({ active, payload, label, lineMap }) => {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  const record = payload[0]?.payload as ForecastChartPoint | undefined;
  const phaseLabel =
    record?.phase === 'forecast' ? '예측 구간' : record?.phase === 'history' ? '실적 구간' : undefined;

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <div className="font-semibold text-slate-700">{label}</div>
      {phaseLabel && (
        <div className="mt-1 inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-600">
          {phaseLabel}
        </div>
      )}
      <ul className="mt-2 space-y-1">
        {payload.map((entry) => {
          const key = entry.dataKey ?? '';
          const line = typeof key === 'string' ? lineMap[key] : undefined;
          const value =
            typeof entry.value === 'number' && Number.isFinite(entry.value)
              ? entry.value.toLocaleString()
              : '—';
          return (
            <li key={key} className="flex items-center justify-between text-slate-600">
              <span className="mr-4 text-[11px] font-medium text-slate-500">{line?.name ?? key}</span>
              <span className="font-semibold text-slate-800">{value}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const ForecastChart: React.FC<ForecastChartProps> = ({
  data,
  lines,
  colors = DEFAULT_COLORS,
  forecastRange,
  loading = false,
  error = null,
}) => {
  if (loading) {
    return (
      <div className="h-80 flex items-center justify-center text-sm text-slate-500">
        선택한 품목의 머신러닝 예측을 불러오는 중입니다...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-80 flex items-center justify-center text-sm text-rose-500 text-center px-6">
        {error}
      </div>
    );
  }

  if (data.length === 0 || lines.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-sm text-slate-400">
        표시할 예측 데이터가 없습니다.
      </div>
    );
  }

  const colorPalette = lines.map((line, index) => line.color ?? colors[index % colors.length]);
  const lineMap = lines.reduce<Record<string, ForecastChartLine>>((acc, line) => {
    acc[line.key] = line;
    return acc;
  }, {});

  let shadedRange = forecastRange ?? null;
  if (!shadedRange) {
    const forecastStart = data.find((point) => point.phase === 'forecast')?.date;
    const forecastEnd = data
      .slice()
      .reverse()
      .find((point) => point.phase === 'forecast')?.date;
    if (forecastStart && forecastEnd) {
      shadedRange = { start: forecastStart, end: forecastEnd };
    }
  }

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" />
          <YAxis />
          <Tooltip content={(props) => <ForecastTooltip {...props} lineMap={lineMap} />} />
          {shadedRange && (
            <ReferenceArea
              x1={shadedRange.start}
              x2={shadedRange.end}
              fill={colorPalette[1] ?? colorPalette[0]}
              fillOpacity={0.12}
              strokeOpacity={0}
            />
          )}
          {lines.map((line, index) => (
            <Line
              key={line.key}
              type="monotone"
              dataKey={line.key}
              name={line.name}
              stroke={line.color ?? colorPalette[index]}
              strokeWidth={2.4}
              dot={false}
              strokeDasharray={line.strokeDasharray}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default ForecastChart;
