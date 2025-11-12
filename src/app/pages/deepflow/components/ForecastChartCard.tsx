import * as React from 'react';
import { motion } from 'framer-motion';
import ForecastChart, { type ForecastChartPoint, type ForecastRange } from './ForecastChart';

interface ForecastChartCardProps {
  sku: string | null;
  chartData: ForecastChartPoint[];
  forecastRange?: ForecastRange | null;
  loading?: boolean;
  error?: string | null;
  children?: React.ReactNode;
  toolbar?: React.ReactNode;
  unit?: string | null;
  includeTodayAsForecast?: boolean;
  accuracy?: {
    wape?: number | null;
    bias?: number | null;
    coverage?: number | null;
  } | null;
}

const ForecastChartCard: React.FC<ForecastChartCardProps> = ({
  sku,
  chartData,
  forecastRange,
  loading = false,
  error = null,
  toolbar,
  children,
  unit,
  includeTodayAsForecast,
  accuracy,
}) => {
  const formatAccuracy = (value?: number | null) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return 'N/A';
    }
    return `${value.toFixed(1)}%`;
  };

  return (
    <motion.section
      className="col-span-12 rounded-3xl border border-white/70 bg-white/60 p-5 shadow-lg backdrop-blur-sm"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">수요 추이 및 예측</h3>
          <p className="mt-1 text-sm text-slate-500">
            {sku ? `품번 ${sku}` : 'SKU를 선택해 예측 곡선을 확인하세요.'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
          {accuracy && (
            <div className="flex flex-wrap items-center gap-1 text-[11px] font-semibold text-slate-600">
              <span className="rounded-full bg-slate-100 px-2 py-1">WAPE {formatAccuracy(accuracy.wape)}</span>
              <span className="rounded-full bg-slate-100 px-2 py-1">Bias {formatAccuracy(accuracy.bias)}</span>
              <span className="rounded-full bg-slate-100 px-2 py-1">
                P90 커버리지 {formatAccuracy(accuracy.coverage)}
              </span>
            </div>
          )}
          {toolbar && <div className="flex items-center gap-2">{toolbar}</div>}
        </div>
      </div>
      <ForecastChart
        data={chartData}
        forecastRange={forecastRange ?? undefined}
        loading={loading}
        error={error}
        unitLabel={unit ?? 'EA'}
        includeTodayAsForecast={includeTodayAsForecast}
      />
      {children}
    </motion.section>
  );
};

export default ForecastChartCard;
