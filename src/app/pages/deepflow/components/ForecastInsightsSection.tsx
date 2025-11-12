import * as React from 'react';
import type { ForecastExplanation, ForecastInsight, ForecastResponse } from '../../../../services/api';
import SalesAnalysisPanel from './SalesAnalysisPanel';
import ModelInterpretationBlock from './ModelInterpretationBlock';
import ActionPlanCards from './ActionPlanCards';
import type { ActionPlanItem, ActionPlanRecord } from '../../../../services/actionPlans';

interface ForecastInsightsSectionProps {
  sku: string | null;
  productName?: string;
  metrics: ForecastResponse['metrics'] | null;
  insight: ForecastInsight | null;
  fallbackExplanation: ForecastExplanation | null;
  actionPlan: ActionPlanRecord | null;
  fallbackActionItems: ActionPlanItem[];
  loading?: boolean;
  insightLoading?: boolean;
  insightError?: string | null;
  insightNotice?: string | null;
  actionPlanLoading?: boolean;
  actionPlanSubmitting?: boolean;
  actionPlanApproving?: boolean;
  onSubmitActionPlan?: (planId: string) => void;
  onApproveActionPlan?: (planId: string) => void;
}

const ForecastInsightsSection: React.FC<ForecastInsightsSectionProps> = ({
  sku,
  productName,
  metrics,
  insight,
  fallbackExplanation,
  actionPlan,
  fallbackActionItems,
  loading = false,
  insightLoading = false,
  insightError = null,
  insightNotice = null,
  actionPlanLoading = false,
  actionPlanSubmitting = false,
  actionPlanApproving = false,
  onSubmitActionPlan,
  onApproveActionPlan,
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
      <ActionPlanCards
        plan={actionPlan}
        fallbackItems={fallbackActionItems}
        loading={aggregatedLoading || actionPlanLoading}
        submitting={actionPlanSubmitting}
        approving={actionPlanApproving}
        onSubmit={onSubmitActionPlan}
        onApprove={onApproveActionPlan}
      />
    </div>
  );
};

export default ForecastInsightsSection;
