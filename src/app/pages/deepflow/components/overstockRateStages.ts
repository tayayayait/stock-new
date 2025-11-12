export type OverstockRateStageKey = 'SHORTAGE' | 'EXCELLENT' | 'GOOD' | 'WATCH' | 'ISSUE' | 'SEVERE';

export interface OverstockRateStageDefinition {
  key: OverstockRateStageKey;
  label: string;
  shortLabel: string;
  description: string;
  action: string;
  rangeLabel: string;
  min: number;
  max: number;
  badgeClassName: string;
  showInLegend: boolean;
}

const buildStage = (
  stage: Omit<OverstockRateStageDefinition, 'badgeClassName'> & { badgeClassName?: string },
): OverstockRateStageDefinition => ({
  badgeClassName: stage.badgeClassName ?? 'border-slate-200 bg-slate-50 text-slate-600',
  ...stage,
});

export const OVERSTOCK_RATE_STAGE_DEFINITIONS: OverstockRateStageDefinition[] = [
  buildStage({
    key: 'SHORTAGE',
    label: '부족 상태',
    shortLabel: '부족',
    description: '안전재고에 미달된 상태로 과잉이 아닌 결품 위험 신호입니다.',
    action: '공급 계획을 재점검하고 긴급 보충을 우선하세요.',
    rangeLabel: '0% 미만',
    min: Number.NEGATIVE_INFINITY,
    max: 0,
    badgeClassName: 'border-rose-200 bg-rose-50 text-rose-700',
    showInLegend: false,
  }),
  buildStage({
    key: 'EXCELLENT',
    label: '우수한 수준',
    shortLabel: '우수',
    description: '재고가 효율적으로 관리되고 있으며 수요 예측이 정확합니다.',
    action: '운영 방식을 유지하되 과도한 저재고가 되지 않도록 모니터링하세요.',
    rangeLabel: '0~10%',
    min: 0,
    max: 10,
    badgeClassName: 'border-sky-200 bg-sky-50 text-sky-700',
    showInLegend: true,
  }),
  buildStage({
    key: 'GOOD',
    label: '양호한 수준',
    shortLabel: '양호',
    description: '산업 평균 범위 안으로 약간의 여유 재고를 유지 중입니다.',
    action: '안정적인 공급이 가능하며 단기 수요 변동에 대비하면 충분합니다.',
    rangeLabel: '10~20%',
    min: 10,
    max: 20,
    badgeClassName: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    showInLegend: true,
  }),
  buildStage({
    key: 'WATCH',
    label: '주의 필요',
    shortLabel: '주의',
    description: '일부 품목이 과잉일 수 있어 수요 예측이나 발주 주기 점검이 필요합니다.',
    action: '발주량·주기를 조정하고 느린 회전 SKU를 구분해 재배치하세요.',
    rangeLabel: '20~30%',
    min: 20,
    max: 30,
    badgeClassName: 'border-amber-200 bg-amber-50 text-amber-700',
    showInLegend: true,
  }),
  buildStage({
    key: 'ISSUE',
    label: '문제 발생 단계',
    shortLabel: '문제',
    description: '불필요한 자금이 재고에 묶여 있으며 소진 속도가 느립니다.',
    action: '할인·프로모션 또는 창고 간 재배치를 실행해 재고를 줄이세요.',
    rangeLabel: '30~50%',
    min: 30,
    max: 50,
    badgeClassName: 'border-orange-200 bg-orange-50 text-orange-700',
    showInLegend: true,
  }),
  buildStage({
    key: 'SEVERE',
    label: '심각한 과잉재고',
    shortLabel: '심각',
    description: '수요 예측 실패나 납기 불균형으로 대규모 과잉이 발생했습니다.',
    action: '즉시 처분 전략, 생산·발주 중단, 공급사 조정을 병행하세요.',
    rangeLabel: '50% 이상',
    min: 50,
    max: Number.POSITIVE_INFINITY,
    badgeClassName: 'border-red-200 bg-red-50 text-red-700',
    showInLegend: true,
  }),
];

export const OVERSTOCK_RATE_LEGEND_STAGES = OVERSTOCK_RATE_STAGE_DEFINITIONS.filter((stage) => stage.showInLegend);

export const classifyOverstockRate = (
  rate: number | null | undefined,
): OverstockRateStageDefinition | null => {
  if (!Number.isFinite(rate as number)) {
    return null;
  }

  const value = rate as number;
  for (const stage of OVERSTOCK_RATE_STAGE_DEFINITIONS) {
    if (value < stage.min) {
      continue;
    }
    if (stage.max === Number.POSITIVE_INFINITY) {
      return stage;
    }
    if (value < stage.max) {
      return stage;
    }
  }

  return null;
};
