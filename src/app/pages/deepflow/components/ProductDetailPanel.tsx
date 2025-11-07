import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Product } from '../../../../domains/products';
import {
  listMovements,
  type MovementSummary,
  type MovementType,
  type MovementLocationSummary,
} from '../../../../services/movements';
import {
  fetchLocations,
  fetchWarehouses,
  fetchStockLevels,
  type ApiLocation,
  type ApiWarehouse,
  type StockLevelListResponse,
} from '../../../../services/api';
import { listPartners } from '../../../../services/orders';
import { formatWarehouseLocationLabel } from '../../../../utils/warehouse';
import { getLocationLabel } from '../../../../app/utils/locationLabelRegistry';

interface ProductDetailPanelProps {
  product: Product | null;
}

type MovementStatus = 'idle' | 'loading' | 'success' | 'error';

interface MovementState {
  status: MovementStatus;
  items: MovementSummary[];
  error?: string;
}

const formatCurrency = (value: number | null | undefined, currency?: string | null): string => {
  if (!Number.isFinite(value ?? NaN)) {
    return '데이터 없음';
  }

  const normalized = Number(value);
  const formatter = new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: currency?.trim() || 'KRW',
    currencyDisplay: 'symbol',
    maximumFractionDigits: 0,
  });

  return formatter.format(normalized);
};

const ProductDetailPanel: React.FC<ProductDetailPanelProps> = ({ product }) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'transactions'>('overview');
  const [movementState, setMovementState] = useState<MovementState>({ status: 'idle', items: [] });
  const [movementRequestId, setMovementRequestId] = useState(0);
  const lastSkuRef = useRef<string>();
  const [warehouseCatalog, setWarehouseCatalog] = useState<Record<string, ApiWarehouse>>({});
  const [locationCatalog, setLocationCatalog] = useState<Record<string, ApiLocation>>({});
  const locationFetchStateRef = useRef<Record<string, 'idle' | 'loading' | 'loaded'>>({});
  const partnerLoadedRef = useRef(false);
  const warehouseFetchInProgressRef = useRef(false);
  const [partnerCatalog, setPartnerCatalog] = useState<Record<string, string>>({});
  const partnerRefreshInFlightRef = useRef(false);
  const [stockLevels, setStockLevels] = useState<StockLevelListResponse['items'] | null>(null);
  const stockLevelsRequestIdRef = useRef(0);

  useEffect(() => {
    const sku = product?.sku?.trim();
    if (!sku) {
      lastSkuRef.current = undefined;
      setMovementState({ status: 'idle', items: [] });
      return;
    }

    const controller = new AbortController();
    const isSameSku = lastSkuRef.current === sku;
    let isCancelled = false;

    setMovementState((prev) => ({
      status: 'loading',
      items: isSameSku ? prev.items : [],
      error: undefined,
    }));

    listMovements({ sku, limit: 50, signal: controller.signal })
      .then((response) => {
        if (isCancelled) {
          return;
        }
        lastSkuRef.current = sku;
        setMovementState({ status: 'success', items: response.items });
      })
      .catch((error) => {
        if (isCancelled || controller.signal.aborted) {
          return;
        }

        lastSkuRef.current = sku;
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : '입출고 내역을 불러오지 못했습니다.';

        setMovementState((prev) => ({
          status: 'error',
          items: isSameSku ? prev.items : [],
          error: message,
        }));
      });

    return () => {
      isCancelled = true;
      controller.abort();
    };
  }, [product?.sku, movementRequestId]);

  useEffect(() => {
    if (partnerLoadedRef.current) {
      return;
    }

    partnerLoadedRef.current = true;
    let cancelled = false;

    listPartners({ includeSample: true })
      .then((partners) => {
        if (cancelled || !Array.isArray(partners)) {
          return;
        }

        setPartnerCatalog((prev) => {
          const next: Record<string, string> = { ...prev };
          partners.forEach((partner) => {
            if (partner?.id) {
              next[partner.id] = partner.name?.trim() || partner.id;
            }
          });
          return next;
        });
      })
      .catch((error) => {
        console.error('[deepflow] Failed to load partner names', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (partnerRefreshInFlightRef.current) {
      return;
    }
    const unknownPartners = movementState.items.reduce<Set<string>>((set, movement) => {
      const partnerId = movement.partnerId?.trim();
      if (partnerId && !partnerCatalog[partnerId]) {
        set.add(partnerId);
      }
      return set;
    }, new Set<string>());
    if (unknownPartners.size === 0) {
      return;
    }
    partnerRefreshInFlightRef.current = true;
    listPartners({ includeSample: true })
      .then((partners) => {
        setPartnerCatalog((prev) => {
          const next = { ...prev };
          partners.forEach((partner) => {
            if (partner?.id) {
              next[partner.id] = partner.name?.trim() || partner.id;
            }
          });
          return next;
        });
      })
      .catch((error) => {
        console.error('[deepflow] Failed to refresh partner names', error);
      })
      .finally(() => {
        partnerRefreshInFlightRef.current = false;
      });
  }, [movementState.items, partnerCatalog]);

  useEffect(() => {
    const relevantWarehouses = new Set<string>();
    const locationRequests = new Map<string, Set<string>>();

    const addWarehouseCode = (rawCode?: string | null) => {
      const code = rawCode?.trim();
      if (code) {
        relevantWarehouses.add(code);
      }
    };

    const registerLocation = (location?: MovementLocationSummary | null) => {
      const locationCode = location?.locationCode?.trim();
      const warehouseCode = location?.warehouseCode?.trim();
      if (!locationCode) {
        return;
      }

      if (warehouseCode) {
        addWarehouseCode(warehouseCode);
        if (!locationCatalog[locationCode]) {
          const existingSet = locationRequests.get(warehouseCode) ?? new Set<string>();
          existingSet.add(locationCode);
          locationRequests.set(warehouseCode, existingSet);
        }
      }
    };

    if (product?.inventory) {
      product.inventory.forEach((entry) => {
        addWarehouseCode(entry.warehouseCode);
        if (entry.locationCode?.trim() && entry.warehouseCode?.trim() && !locationCatalog[entry.locationCode.trim()]) {
          const code = entry.warehouseCode.trim();
          const requestSet = locationRequests.get(code) ?? new Set<string>();
          requestSet.add(entry.locationCode.trim());
          locationRequests.set(code, requestSet);
        }
      });
    }

    movementState.items.forEach((movement) => {
      registerLocation(movement.from);
      registerLocation(movement.to);
    });

    const missingWarehouses = Array.from(relevantWarehouses).filter(
      (code) => code && !warehouseCatalog[code],
    );

    let cancelled = false;

    if (missingWarehouses.length > 0 && !warehouseFetchInProgressRef.current) {
      warehouseFetchInProgressRef.current = true;
      fetchWarehouses()
        .then((response) => {
          if (cancelled || !response?.items) {
            return;
          }

          setWarehouseCatalog((prev) => {
            const next: Record<string, ApiWarehouse> = { ...prev };
            response.items.forEach((warehouse) => {
              if (warehouse?.code) {
                next[warehouse.code] = warehouse;
              }
            });
            return next;
          });
        })
        .catch((error) => {
          console.error('[deepflow] Failed to load warehouse catalog', error);
        })
        .finally(() => {
          warehouseFetchInProgressRef.current = false;
        });
    }

    const locationFetchTargets = Array.from(locationRequests.entries())
      .map(([warehouseCode]) => warehouseCode)
      .filter((code) => {
        if (!code) {
          return false;
        }
        const status = locationFetchStateRef.current[code];
        return status !== 'loading';
      });

    if (locationFetchTargets.length > 0) {
      locationFetchTargets.forEach((code) => {
        locationFetchStateRef.current[code] = 'loading';
      });

      Promise.all(
        locationFetchTargets.map(async (code) => {
          try {
            const response = await fetchLocations(code, { pageSize: 500 });
            if (cancelled || !response?.items) {
              return;
            }
            setLocationCatalog((prev) => {
              const next: Record<string, ApiLocation> = { ...prev };
              response.items.forEach((location) => {
                if (location?.code) {
                  next[location.code] = location;
                }
              });
              return next;
            });
            locationFetchStateRef.current[code] = 'loaded';
          } catch (error) {
            console.error(`[deepflow] Failed to load locations for warehouse ${code}`, error);
            locationFetchStateRef.current[code] = 'idle';
          }
        }),
      ).catch((error) => {
        console.error('[deepflow] Failed to load location catalog', error);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [product, movementState.items, warehouseCatalog, locationCatalog]);

  useEffect(() => {
    const legacyId = Number.isFinite(product?.legacyProductId)
      ? Number(product?.legacyProductId)
      : null;
    if (!legacyId) {
      setStockLevels(null);
      return;
    }
    const requestId = ++stockLevelsRequestIdRef.current;
    let cancelled = false;
    fetchStockLevels({ productId: legacyId })
      .then((response) => {
        if (cancelled || stockLevelsRequestIdRef.current !== requestId) {
          return;
        }
        const items = Array.isArray(response?.items) ? response.items : [];
        setStockLevels(items);
        if (items.length > 0) {
          setLocationCatalog((prev) => {
            const next = { ...prev };
            items.forEach((item) => {
              const location = item.location;
              if (location?.code) {
                next[location.code] = location;
              }
            });
            return next;
          });
          setWarehouseCatalog((prev) => {
            const next = { ...prev };
            items.forEach((item) => {
              const warehouse = item.location?.warehouse;
              if (warehouse?.code) {
                next[warehouse.code] = warehouse;
              }
            });
            return next;
          });
        }
      })
      .catch((error) => {
        console.error('[deepflow] Failed to load stock levels', error);
        if (!cancelled) {
          setStockLevels(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [product?.legacyProductId]);

  const resolveWarehouseLocation = useCallback(
    (warehouseCode?: string | null, locationCode?: string | null) => {
      const normalizedWarehouseCode = warehouseCode?.trim() ?? '';
      const normalizedLocationCode = locationCode?.trim() ?? '';
      const locationRecord = normalizedLocationCode ? locationCatalog[normalizedLocationCode] : undefined;
      const warehouseRecord = normalizedWarehouseCode ? warehouseCatalog[normalizedWarehouseCode] : undefined;
      const registryLabel = getLocationLabel(normalizedWarehouseCode, normalizedLocationCode);

      const warehouseName =
        locationRecord?.warehouse?.name?.trim() ??
        warehouseRecord?.name?.trim() ??
        registryLabel?.warehouseName?.trim() ??
        null;

      const locationName =
        locationRecord?.description?.trim() ??
        locationRecord?.name?.trim() ??
        registryLabel?.locationName?.trim() ??
        null;

      return formatWarehouseLocationLabel(warehouseName, locationName);
    },
    [locationCatalog, warehouseCatalog],
  );

  const resolveLocationLabel = useCallback(
    (location?: MovementLocationSummary | null) => {
      if (!location) {
        return undefined;
      }

      return resolveWarehouseLocation(location.warehouseCode, location.locationCode);
    },
    [resolveWarehouseLocation],
  );

  const resolvePartnerLabel = useCallback(
    (partnerId?: string | null) => {
      if (!partnerId) {
        return '거래처 정보 없음';
      }

      const name = partnerCatalog[partnerId];
      if (name) {
        return name;
      }

      return '미등록 거래처';
    },
    [partnerCatalog],
  );

  const inventoryEntries = useMemo(() => {
    const reserveLookup = new Map<string, number>();
    (product?.inventory ?? []).forEach((entry) => {
      const warehouseCode = entry.warehouseCode?.trim() ?? '';
      const locationCode = entry.locationCode?.trim() ?? '';
      reserveLookup.set(`${warehouseCode}::${locationCode}`, entry.reserved ?? 0);
    });

    if (stockLevels && stockLevels.length > 0) {
      return stockLevels.map((item) => {
        const warehouseCode =
          item.location?.warehouseCode ??
          item.location?.warehouse?.code ??
          '';
        const warehouseName = item.location?.warehouse?.name?.trim() ?? null;
        const locationCode = item.location?.code ?? '';
        const locationName = item.location?.description?.trim() ?? null;
        const label = formatWarehouseLocationLabel(warehouseName, locationName);
        const key = `${warehouseCode || 'unknown-warehouse'}-${locationCode || 'unknown-location'}`;
        const reserved = reserveLookup.get(`${warehouseCode}::${locationCode}`) ?? 0;
        return {
          key,
          label,
          onHand: item.quantity ?? 0,
          reserved,
        };
      });
    }

    if (!product?.inventory || product.inventory.length === 0) {
      return [];
    }

    return product.inventory.map((entry) => {
      const warehouseCode = entry.warehouseCode?.trim() ?? '';
      const locationCode = entry.locationCode?.trim() ?? '';

      return {
        key: `${warehouseCode || 'unknown-warehouse'}-${locationCode || 'unknown-location'}`,
        label: resolveWarehouseLocation(warehouseCode, locationCode),
        onHand: entry.onHand,
        reserved: entry.reserved,
      };
    });
  }, [product, resolveWarehouseLocation, stockLevels]);

  const totalInventory = useMemo(() => {
    const onHand = Number.isFinite(product?.onHand ?? NaN) ? Number(product?.onHand) : 0;
    const reserved = Number.isFinite(product?.reserved ?? NaN) ? Number(product?.reserved) : 0;
    const available = Math.max(0, onHand - reserved);

    return {
      onHand,
      reserved,
      available,
    };
  }, [product?.onHand, product?.reserved]);

  const movementRows = useMemo(() => {
    if (movementState.items.length === 0) {
      return [];
    }

    return [...movementState.items].sort((a, b) => {
      const aTime = Date.parse(a.occurredAt);
      const bTime = Date.parse(b.occurredAt);
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return bTime - aTime;
      }
      return 0;
    });
  }, [movementState.items]);

  const latestReceipt = useMemo(
    () => movementRows.find((movement) => movement.type === 'RECEIPT'),
    [movementRows],
  );

  const latestIssue = useMemo(
    () => movementRows.find((movement) => movement.type === 'ISSUE'),
    [movementRows],
  );

  const movementDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [],
  );

  const movementTypeLabel: Record<MovementType, string> = useMemo(
    () => ({
      RECEIPT: '입고',
      ISSUE: '출고',
      ADJUST: '조정',
      TRANSFER: '이동',
      RETURN: '반품',
    }),
    [],
  );

  const movementQuantityClass: Record<MovementType, string> = useMemo(
    () => ({
      RECEIPT: 'text-emerald-600',
      ISSUE: 'text-rose-600',
      ADJUST: 'text-slate-600',
      TRANSFER: 'text-indigo-600',
      RETURN: 'text-emerald-600',
    }),
    [],
  );

  const describeMovementLocation = (movement: MovementSummary) => {
    const partnerLabel = resolvePartnerLabel(movement.partnerId);

    if (movement.type === 'TRANSFER') {
      const fromLabel = resolveLocationLabel(movement.from);
      const toLabel = resolveLocationLabel(movement.to);
      const locationLabel =
        fromLabel || toLabel
          ? `${fromLabel ?? '미지정 창고'} → ${toLabel ?? '미지정 창고'}`
          : '창고 정보 없음';
      return { partnerLabel, locationLabel };
    }

    if (movement.type === 'ISSUE') {
      const fromLabel = resolveLocationLabel(movement.from);
      return {
        partnerLabel,
        locationLabel: fromLabel ?? '출고 창고 미지정',
      };
    }

    const toLabel = resolveLocationLabel(movement.to);
    return {
      partnerLabel,
      locationLabel: toLabel ?? '입고 창고 미지정',
    };
  };

  const handleRetryMovements = () => {
    if (!product?.sku) {
      return;
    }
    setMovementRequestId((id) => id + 1);
  };

  const movementStatus = movementState.status;
  const isLoadingMovements = movementStatus === 'loading';
  const hasMovementData = movementRows.length > 0;
  const hasRecentSummary = Boolean(latestReceipt || latestIssue);

  if (!product) {
    return (
      <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
        품목을 선택하면 상세가 표시됩니다.
      </div>
    );
  }

  const currency = product.currency ?? undefined;

  return (
    <div className="flex h-full flex-col rounded-2xl border border-slate-200">
      <div className="border-b border-slate-200 p-4">
        <div className="text-xs font-semibold text-indigo-600">SKU {product.sku}</div>
        <h4 className="mt-1 text-lg font-semibold text-slate-900">{product.name}</h4>
        {product.brand && <p className="mt-1 text-xs text-slate-500">{product.brand}</p>}
      </div>

      <div className="flex items-center gap-2 border-b border-slate-200 px-4 pt-3">
        <button
          type="button"
          className={`rounded-t-lg px-3 py-2 text-sm font-medium ${
            activeTab === 'overview' ? 'border-b-2 border-indigo-500 text-indigo-600' : 'text-slate-500'
          }`}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </button>
        <button
          type="button"
          className={`rounded-t-lg px-3 py-2 text-sm font-medium ${
            activeTab === 'transactions' ? 'border-b-2 border-indigo-500 text-indigo-600' : 'text-slate-500'
          }`}
          onClick={() => setActiveTab('transactions')}
        >
          Transactions
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'overview' ? (
          <div className="space-y-4 text-sm text-slate-600">
            <section>
              <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">재고 요약</h5>
              <div className="mt-1 grid gap-2 rounded-xl border border-slate-200 bg-white px-3 py-3 sm:grid-cols-3">
                <div className="rounded-lg bg-slate-50 px-3 py-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">가용 재고</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">
                    {totalInventory.available.toLocaleString()} EA
                  </div>
                  <div className="text-[11px] text-slate-400">총 재고에서 예약 수량을 제외한 값</div>
                </div>
                <div className="rounded-lg bg-slate-50 px-3 py-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">총 재고</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">
                    {totalInventory.onHand.toLocaleString()} EA
                  </div>
                  <div className="text-[11px] text-slate-400">시스템 상 재고 수량</div>
                </div>
                <div className="rounded-lg bg-slate-50 px-3 py-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">예약 수량</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">
                    {totalInventory.reserved.toLocaleString()} EA
                  </div>
                  <div className="text-[11px] text-slate-400">출고 예약 또는 홀딩 수량</div>
                </div>
              </div>
            </section>

            <section>
              <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">카테고리</h5>
              <div className="mt-1 rounded-xl border border-slate-200 bg-white px-3 py-2">
                <div className="font-medium text-slate-900">{product.category || '미분류'}</div>
                <div className="text-xs text-slate-500">{product.subCategory || '세부 카테고리 없음'}</div>
              </div>
            </section>

            <section>
              <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">최근 입출고 요약</h5>
              <div className="mt-1 rounded-xl border border-slate-200 bg-white px-3 py-3">
                {hasRecentSummary ? (
                  <div className="grid gap-3">
                    {latestReceipt && (
                      <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-600">최근 입고</div>
                          <div className="mt-1 text-sm font-medium text-slate-900">
                            {movementDateFormatter.format(new Date(latestReceipt.occurredAt))}
                          </div>
                          <div className="text-xs text-slate-500">{resolvePartnerLabel(latestReceipt.partnerId)}</div>
                        </div>
                        <div className="text-right text-sm font-semibold text-emerald-600">
                          +{latestReceipt.qty.toLocaleString()} EA
                        </div>
                      </div>
                    )}
                    {latestIssue && (
                      <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-rose-600">최근 출고</div>
                          <div className="mt-1 text-sm font-medium text-slate-900">
                            {movementDateFormatter.format(new Date(latestIssue.occurredAt))}
                          </div>
                          <div className="text-xs text-slate-500">{resolvePartnerLabel(latestIssue.partnerId)}</div>
                        </div>
                        <div className="text-right text-sm font-semibold text-rose-600">
                          -{latestIssue.qty.toLocaleString()} EA
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="py-6 text-center text-xs text-slate-400">최근 입출고 데이터가 없습니다.</div>
                )}
              </div>
            </section>

            <section>
              <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">구매가 / 판매가</h5>
              <div className="mt-1 grid gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">구매가</span>
                  <span className="font-medium text-slate-900">{formatCurrency(product.supplyPrice, currency)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">판매가</span>
                  <span className="font-medium text-slate-900">{formatCurrency(product.salePrice, currency)}</span>
                </div>
              </div>
            </section>

            <section>
              <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">위치별 재고</h5>
              <div className="mt-1 space-y-2">
                {inventoryEntries.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 bg-white px-3 py-4 text-center text-xs text-slate-400">
                    등록된 창고 재고 정보가 없습니다.
                  </div>
                ) : (
                  inventoryEntries.map((entry) => (
                    <div key={entry.key} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                      <div className="text-xs font-semibold text-slate-500">{entry.label}</div>
                      <div className="mt-1 flex items-center justify-between text-sm">
                        <span className="text-slate-600">가용 재고</span>
                        <span className="font-semibold text-slate-900">{(entry.onHand - entry.reserved).toLocaleString()}</span>
                      </div>
                      <div className="mt-0.5 grid grid-cols-2 gap-1 text-[11px] text-slate-500">
                        <span>재고 {entry.onHand.toLocaleString()}</span>
                        <span className="text-right">예약 {entry.reserved.toLocaleString()}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        ) : (
          <div className="space-y-3">
            <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">최근 입출고 내역</h5>
            <div className="rounded-xl border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 text-xs text-slate-500">
                <span>
                  {isLoadingMovements
                    ? '입출고 내역을 불러오는 중...'
                    : hasMovementData
                      ? `총 ${movementRows.length.toLocaleString()}건`
                      : '데이터가 없습니다.'}
                </span>
                {movementStatus === 'error' && (
                  <button
                    type="button"
                    onClick={handleRetryMovements}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-400 hover:text-slate-800"
                  >
                    다시 시도
                  </button>
                )}
              </div>

              {movementStatus === 'error' && !hasMovementData ? (
                <div className="px-4 py-10 text-center text-sm text-rose-600">
                  {movementState.error ?? '입출고 내역을 불러오는 중 오류가 발생했습니다.'}
                </div>
              ) : hasMovementData ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium">날짜</th>
                        <th className="px-4 py-3 text-left font-medium">구분</th>
                        <th className="px-4 py-3 text-right font-medium">수량</th>
                        <th className="px-4 py-3 text-left font-medium">거래처 · 창고</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-slate-600">
                      {movementRows.map((movement) => {
                        const { partnerLabel, locationLabel } = describeMovementLocation(movement);
                        return (
                          <tr key={movement.id} className="align-top">
                            <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">
                              {movementDateFormatter.format(new Date(movement.occurredAt))}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-xs font-semibold text-slate-700">
                              {movementTypeLabel[movement.type]}
                            </td>
                            <td className={`whitespace-nowrap px-4 py-3 text-right text-sm font-semibold ${movementQuantityClass[movement.type]}`}>
                              {movement.type === 'ISSUE' ? '-' : movement.type === 'RECEIPT' ? '+' : ''}
                              {movement.qty.toLocaleString()} EA
                            </td>
                            <td className="px-4 py-3">
                              <div className="text-sm font-medium text-slate-700">{partnerLabel}</div>
                              <div className="text-xs text-slate-500">{locationLabel}</div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-4 py-10 text-center text-sm text-slate-400">
                  입출고 내역 데이터가 없습니다.
                </div>
              )}

              {isLoadingMovements && hasMovementData && (
                <div className="border-t border-slate-200 px-4 py-3 text-center text-xs text-slate-500">
                  최신 데이터를 불러오는 중입니다...
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ProductDetailPanel;
