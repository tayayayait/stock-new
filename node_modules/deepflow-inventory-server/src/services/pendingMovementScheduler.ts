import { InventoryConflictError, finalizeMovementDraft } from './movementProcessor.js';
import {
  requeuePendingMovement,
  takeDuePendingMovements,
} from '../stores/pendingMovementsStore.js';

const DEFAULT_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;

const processDueMovements = () => {
  const due = takeDuePendingMovements(new Date());
  due.forEach((record) => {
    try {
      finalizeMovementDraft(record.draft);
    } catch (error) {
      if (error instanceof InventoryConflictError) {
        requeuePendingMovement(record);
      } else {
        requeuePendingMovement(record);
        console.error('Failed to finalize pending movement', error);
      }
    }
  });
};

export const startPendingMovementScheduler = (intervalMs = DEFAULT_INTERVAL_MS): void => {
  if (timer) {
    return;
  }
  processDueMovements();
  timer = setInterval(processDueMovements, intervalMs) as NodeJS.Timeout;
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
};

export const stopPendingMovementScheduler = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
