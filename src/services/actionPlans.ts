import type { ActionPlanItem, ActionPlanRecord, ActionPlanStatus } from '@/shared/actionPlans/types';
import { get, post, put } from './api';

interface ActionPlanListResponse {
  items: ActionPlanRecord[];
}

export interface ListActionPlanParams {
  sku?: string;
  productId?: number;
  status?: ActionPlanStatus;
  limit?: number;
}

export const listActionPlans = async (params: ListActionPlanParams = {}): Promise<ActionPlanRecord[]> => {
  const search = new URLSearchParams();
  if (params.sku) search.set('sku', params.sku);
  if (Number.isFinite(params.productId)) search.set('productId', String(params.productId));
  if (params.status) search.set('status', params.status);
  if (Number.isFinite(params.limit)) search.set('limit', String(params.limit));

  const query = search.toString();
  const path = query ? `/api/action-plans?${query}` : '/api/action-plans';
  const response = await get<ActionPlanListResponse>(path);
  return response.items ?? [];
};

export const fetchLatestActionPlan = async (params: { sku: string; productId?: number }) => {
  const items = await listActionPlans({ ...params, limit: 1 });
  return items[0] ?? null;
};

export const submitActionPlan = async (planId: string) => {
  const response = await post<{ plan: ActionPlanRecord }>(`/api/action-plans/${planId}/submit`);
  return response.plan;
};

export const approveActionPlan = async (planId: string) => {
  const response = await post<{ plan: ActionPlanRecord }>(`/api/action-plans/${planId}/approve`);
  return response.plan;
};

export const updateActionPlan = async (planId: string, items: ActionPlanItem[]) => {
  const response = await put<{ plan: ActionPlanRecord }>(`/api/action-plans/${planId}`, { items });
  return response.plan;
};

export type { ActionPlanItem, ActionPlanRecord, ActionPlanStatus } from '@/shared/actionPlans/types';
