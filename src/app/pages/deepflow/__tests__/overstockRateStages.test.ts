import { describe, expect, it } from 'vitest';

import {
  OVERSTOCK_RATE_STAGE_DEFINITIONS,
  classifyOverstockRate,
} from '../components/overstockRateStages';

describe('overstockRateStages', () => {
  it('returns null for non-finite inputs', () => {
    expect(classifyOverstockRate(null)).toBeNull();
    expect(classifyOverstockRate(undefined)).toBeNull();
    expect(classifyOverstockRate(Number.NaN)).toBeNull();
  });

  it('classifies shortage when the value is below zero', () => {
    const stage = classifyOverstockRate(-5);
    expect(stage?.key).toBe('SHORTAGE');
  });

  it('treats the lower bound as inclusive and upper bound as exclusive', () => {
    expect(classifyOverstockRate(0)?.key).toBe('EXCELLENT');
    expect(classifyOverstockRate(9.99)?.key).toBe('EXCELLENT');
    expect(classifyOverstockRate(10)?.key).toBe('GOOD');
    expect(classifyOverstockRate(19.999)?.key).toBe('GOOD');
    expect(classifyOverstockRate(20)?.key).toBe('WATCH');
    expect(classifyOverstockRate(29.999)?.key).toBe('WATCH');
    expect(classifyOverstockRate(30)?.key).toBe('ISSUE');
    expect(classifyOverstockRate(49.999)?.key).toBe('ISSUE');
    expect(classifyOverstockRate(50)?.key).toBe('SEVERE');
  });

  it('returns the highest stage for large numbers', () => {
    expect(classifyOverstockRate(500)?.key).toBe('SEVERE');
  });

  it('exports shortage stage even if it is hidden from the legend list', () => {
    const shortage = OVERSTOCK_RATE_STAGE_DEFINITIONS.find((stage) => stage.key === 'SHORTAGE');
    expect(shortage).toBeDefined();
    expect(shortage?.showInLegend).toBe(false);
  });
});
