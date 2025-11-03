import * as React from 'react';
import { motion } from 'framer-motion';
import ForecastChart, {
  type ForecastChartLine,
  type ForecastChartPoint,
  type ForecastRange,
} from './ForecastChart';

interface ForecastChartCardProps {
  sku: string | null;
  chartData: ForecastChartPoint[];
  lines: ForecastChartLine[];
  forecastRange?: ForecastRange | null;
  colors?: string[];
  loading?: boolean;
  error?: string | null;
  children?: React.ReactNode;
  toolbar?: React.ReactNode;
}

const ForecastChartCard: React.FC<ForecastChartCardProps> = ({
  sku,
  chartData,
  lines,
  forecastRange,
  colors,
  loading = false,
  error = null,
  toolbar,
  children,
}) => {
  return (
    <motion.section
      className="col-span-12 rounded-3xl border border-white/70 bg-white/60 p-5 shadow-lg backdrop-blur-sm"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">품번: {sku ?? '선택 없음'}</h3>
        {toolbar}
      </div>
      <ForecastChart
        data={chartData}
        lines={lines}
        colors={colors}
        forecastRange={forecastRange ?? undefined}
        loading={loading}
        error={error}
      />
      {children}
    </motion.section>
  );
};

export default ForecastChartCard;
