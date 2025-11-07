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
  className?: string;
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
  className = '',
}) => {
  return (
    <motion.section
      className={`col-span-12 rounded-3xl border border-white/70 bg-white/60 p-5 shadow-lg backdrop-blur-sm ${className}`}
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
        {toolbar && <div className="flex items-center gap-2">{toolbar}</div>}
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
