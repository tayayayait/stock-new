import { randomUUID } from 'node:crypto';
import type { MovementDraft, PendingMovementRecord } from '../../../shared/movements/types.js';

const pendingMovements: PendingMovementRecord[] = [];

export const enqueuePendingMovement = (draft: MovementDraft): PendingMovementRecord => {
  const record: PendingMovementRecord = {
    id: randomUUID(),
    draft: { ...draft },
    enqueuedAt: new Date().toISOString(),
  };
  pendingMovements.push(record);
  return record;
};

export const listPendingMovements = (): PendingMovementRecord[] => [...pendingMovements];

export const takeDuePendingMovements = (now: Date): PendingMovementRecord[] => {
  const due: PendingMovementRecord[] = [];
  const remaining: PendingMovementRecord[] = [];

  const nowTime = now.getTime();

  pendingMovements.forEach((record) => {
    const occurredTime = new Date(record.draft.occurredAt).getTime();
    if (!Number.isFinite(occurredTime) || occurredTime <= nowTime) {
      due.push(record);
    } else {
      remaining.push(record);
    }
  });

  pendingMovements.splice(0, pendingMovements.length, ...remaining);
  return due;
};

export const requeuePendingMovement = (record: PendingMovementRecord): void => {
  pendingMovements.push({
    ...record,
    enqueuedAt: new Date().toISOString(),
  });
};

export const clearPendingMovements = (): void => {
  pendingMovements.splice(0, pendingMovements.length);
};
