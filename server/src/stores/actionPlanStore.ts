import { randomUUID } from 'crypto';

import {
  type ActionPlanFilter,
  type ActionPlanItem,
  type ActionPlanRecord,
  type ActionPlanStatus,
  type ActionPlanUpsertPayload,
} from '../../../shared/actionPlans/types.js';

const actionPlanStore = new Map<string, ActionPlanRecord>();

const STATUS_ORDER: ActionPlanStatus[] = ['draft', 'reviewed', 'approved'];

const nowIso = () => new Date().toISOString();

const clampStatus = (status?: ActionPlanStatus): ActionPlanStatus => {
  if (status && STATUS_ORDER.includes(status)) {
    return status;
  }
  return 'draft';
};

const sanitizeItems = (items: ActionPlanItem[]): ActionPlanItem[] =>
  items
    .map((item, index) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const id = item.id?.trim() || `plan-${index + 1}`;
      const who = item.who?.trim();
      const what = item.what?.trim();
      const when = item.when?.trim();
      const rationale = item.rationale?.trim() || '';
      const confidence = Number.isFinite(item.confidence) ? Math.max(Math.min(item.confidence, 1), 0) : 0.5;
      const kpiName = item.kpi?.name?.trim();
      const kpiTarget =
        typeof item.kpi?.target === 'number' || typeof item.kpi?.target === 'string'
          ? item.kpi.target
          : '';
      const kpiWindow = item.kpi?.window?.trim();

      if (!who || !what || !when || !kpiName || !kpiWindow) {
        return null;
      }

      return {
        id,
        who,
        what,
        when,
        rationale,
        confidence,
        kpi: {
          name: kpiName,
          target: kpiTarget,
          window: kpiWindow,
        },
      };
    })
    .filter((item): item is ActionPlanItem => Boolean(item && item.kpi));

export function listActionPlans(filter: ActionPlanFilter = {}): ActionPlanRecord[] {
  const entries = Array.from(actionPlanStore.values());

  return entries
    .filter((record) => {
      if (filter.sku && record.sku !== filter.sku) {
        return false;
      }
      if (filter.productId && record.productId !== filter.productId) {
        return false;
      }
      if (filter.status && record.status !== filter.status) {
        return false;
      }
      return true;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, filter.limit && filter.limit > 0 ? filter.limit : undefined);
}

export function getActionPlan(id: string): ActionPlanRecord | undefined {
  return actionPlanStore.get(id);
}

export function saveActionPlan(payload: ActionPlanUpsertPayload): ActionPlanRecord {
  const items = sanitizeItems(payload.items ?? []);
  const id = randomUUID();
  const timestamp = nowIso();

  const record: ActionPlanRecord = {
    id,
    sku: payload.sku,
    productId: payload.productId,
    status: clampStatus(payload.status),
    source: payload.source ?? 'llm',
    language: payload.language ?? 'ko',
    version: payload.version ?? 'v1',
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: payload.createdBy ?? 'system',
    items,
  };

  actionPlanStore.set(id, record);
  return record;
}

export function updateActionPlan(id: string, patch: Partial<ActionPlanRecord>): ActionPlanRecord {
  const existing = actionPlanStore.get(id);
  if (!existing) {
    throw new Error(`Action plan ${id} not found`);
  }

  const next: ActionPlanRecord = {
    ...existing,
    ...patch,
    items: patch.items ? sanitizeItems(patch.items) : existing.items,
    updatedAt: nowIso(),
  };

  actionPlanStore.set(id, next);
  return next;
}

export function transitionActionPlanStatus(
  id: string,
  nextStatus: ActionPlanStatus,
  actor: { name: string; role: 'planner' | 'approver' },
): ActionPlanRecord {
  const existing = actionPlanStore.get(id);
  if (!existing) {
    throw new Error(`Action plan ${id} not found`);
  }

  const currentIndex = STATUS_ORDER.indexOf(existing.status);
  const nextIndex = STATUS_ORDER.indexOf(nextStatus);
  if (nextIndex === -1) {
    throw new Error(`Unsupported status: ${nextStatus}`);
  }
  if (nextIndex < currentIndex) {
    throw new Error(`Cannot move status backwards from ${existing.status} to ${nextStatus}`);
  }

  const updated: ActionPlanRecord = {
    ...existing,
    status: nextStatus,
    updatedAt: nowIso(),
  };

  if (nextStatus === 'reviewed') {
    updated.reviewedBy = actor.name;
    updated.submittedAt = updated.updatedAt;
  }
  if (nextStatus === 'approved') {
    updated.approvedBy = actor.name;
    updated.approvedAt = updated.updatedAt;
  }

  actionPlanStore.set(id, updated);
  return updated;
}

export function resetActionPlanStore() {
  actionPlanStore.clear();
}
