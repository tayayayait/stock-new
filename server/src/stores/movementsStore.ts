import type { MovementRecord } from '../../../shared/movements/types.js';

const movementStore: MovementRecord[] = [];

export const addMovementRecord = (record: MovementRecord): void => {
  movementStore.push(record);
};

export const listMovementRecords = (): MovementRecord[] => [...movementStore];

export const findMovementRecords = (
  predicate: (movement: MovementRecord) => boolean,
): MovementRecord[] => movementStore.filter(predicate);

export const getMovementRecordById = (id: string): MovementRecord | undefined =>
  movementStore.find((movement) => movement.id === id);

export const clearMovementStore = (): void => {
  movementStore.splice(0, movementStore.length);
};
