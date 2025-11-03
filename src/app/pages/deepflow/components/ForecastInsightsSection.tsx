import * as React from 'react';
import type { ForecastExplanation, ForecastInsight, ForecastResponse } from '../../../../services/api';
import SalesAnalysisPanel from './SalesAnalysisPanel';
import ModelInterpretationBlock from './ModelInterpretationBlock';
import ActionPlanCards, { type ActionPlanItem } from './ActionPlanCards';

interface ForecastInsightsSectionProps {
  sku: string | null;
  productName?: string;
  metrics: ForecastResponse['metrics'] | null;
  insight: ForecastInsight | null;
  fallbackExplanation: ForecastExplanation | null;
  actionItems: ActionPlanItem[];
  loading?: boolean;
  insightLoading?: boolean;
  insightError?: string | null;
  insightNotice?: string | null;
}

const ForecastInsightsSection: React.FC<ForecastInsightsSectionProps> = ({
  sku,
  productName,
  metrics,
  insight,
  fallbackExplanation,
  actionItems,
  loading = false,
  insightLoading = false,
  insightError = null,
  insightNotice = null,
}) => {
  const aggregatedLoading = loading || insightLoading;

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
      <SalesAnalysisPanel
        sku={sku}
        productName={productName}
        metrics={metrics}
        loading={loading}
      />
      <ModelInterpretationBlock
        insight={insight}
        fallback={fallbackExplanation}
        loading={aggregatedLoading}
        error={insightError}
        notice={insightNotice}
      />
      <ActionPlanCards items={actionItems} loading={aggregatedLoading} />
    </div>
  );
};

export default ForecastInsightsSection;
