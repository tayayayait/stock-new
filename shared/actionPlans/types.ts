export type ActionPlanStatus = 'draft' | 'reviewed' | 'approved';

export interface ActionPlanKpi {
  name: string;
  target: string | number;
  window: string;
}

export interface ActionPlanItem {
  id: string;
  who: string;
  what: string;
  when: string;
  kpi: ActionPlanKpi;
  rationale: string;
  confidence: number;
}

export interface ActionPlanRecord {
  id: string;
  sku: string;
  productId?: number;
  status: ActionPlanStatus;
  source: 'llm' | 'manual';
  language: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  reviewedBy?: string;
  approvedBy?: string;
  submittedAt?: string;
  approvedAt?: string;
  items: ActionPlanItem[];
}

export interface ActionPlanUpsertPayload {
  sku: string;
  productId?: number;
  status?: ActionPlanStatus;
  source?: 'llm' | 'manual';
  createdBy?: string;
  items: ActionPlanItem[];
  language?: string;
  version?: string;
}

export interface ActionPlanFilter {
  sku?: string;
  productId?: number;
  limit?: number;
  status?: ActionPlanStatus;
}
