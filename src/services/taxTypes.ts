import { get, post } from './api';

export type TaxMode = 'exclusive' | 'inclusive';

export interface TaxType {
  id: string;
  name: string;
  rate: number; // stored as decimal (e.g., 0.12)
  mode: TaxMode;
  isDefault?: boolean;
}

interface TaxTypeListResponse {
  success: true;
  items: TaxType[];
}

interface TaxTypeResponse {
  success: true;
  item: TaxType;
}

export const listTaxTypes = async (): Promise<TaxType[]> => {
  const response = await get<TaxTypeListResponse>('/tax-types');
  return response.items;
};

export const createTaxType = async (payload: {
  name: string;
  rate: number;
  mode: TaxMode;
  isDefault?: boolean;
}): Promise<TaxType> => {
  const response = await post<TaxTypeResponse>('/tax-types', payload);
  return response.item;
};
