export type MovementType = 'RECEIPT' | 'ISSUE' | 'ADJUST' | 'TRANSFER' | 'RETURN';

export const MOVEMENT_TYPES: readonly MovementType[] = ['RECEIPT', 'ISSUE', 'ADJUST', 'TRANSFER', 'RETURN'] as const;

export interface MovementDraft {
  type: MovementType;
  sku: string;
  qty: number;
  userId: string;
  occurredAt: string;
  partnerId?: string;
  refNo?: string;
  memo?: string;
  fromWarehouse?: string;
  fromLocation?: string;
  toWarehouse?: string;
  toLocation?: string;
  poId?: string;
  poLineId?: string;
  soId?: string;
  soLineId?: string;
}

export interface MovementRecord extends MovementDraft {
  id: string;
  createdAt: string;
}

export interface PendingMovementRecord {
  id: string;
  draft: MovementDraft;
  enqueuedAt: string;
}
