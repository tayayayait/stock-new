import React, { useEffect, useMemo, useState, useCallback } from 'react';
import Card from '../../../../../components/ui/Card';
import { useToast } from '../../../../components/Toaster';
// Warehouse API imports removed
import {
  listPartners,
  listSalesOrders,
  getSalesOrder,
  type ImportShipmentsResult,
  type Partner,
  type OrderFulfillmentEvent,
} from '../../../../services/orders';
import type { Product } from '../../../../domains/products';
import ShipmentFlowChart from './ShipmentFlowChart';
import ImportShipmentsModal, { SHIPMENTS_TEMPLATE_URL } from './ImportShipmentsModal';

interface PolicyOpsDashboardProps {
  products: Product[];
}

interface ShipmentEvent {
  sku: string;
  quantity: number;
  occurredAt: string;
  partnerId: string;
  warehouseCode?: string;
  category?: string;
  productName?: string;
}

interface SkuMonthTotal {
  quantity: number;
  category: string;
  // Track all observed names for the SKU in this month to detect conflicts
  names: Map<string, number>;
}

interface MonthlyAggregate {
  total: number;
  categoryTotals: Map<string, number>;
  partnerTotals: Map<string, number>;
  skuTotals: Map<string, SkuMonthTotal>;
  events: ShipmentEvent[];
}

const monthNumbers = Array.from({ length: 12 }, (_, index) => index + 1);
const barPalette = ['#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#c084fc', '#94a3b8'];
const CATEGORY_TOP_COUNT = 5;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const toKstDate = (value: string | number | Date): Date | null => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Date(date.getTime() + KST_OFFSET_MS);
};

const getKstYearMonth = (value: string | number | Date): { year: number; month: number } | null => {
  const date = toKstDate(value);
  if (!date) {
    return null;
  }
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
  };
};

const getCurrentKstComponents = () => {
  const result = getKstYearMonth(Date.now());
  if (result) {
    return result;
  }
  const fallback = new Date();
  return { year: fallback.getUTCFullYear(), month: fallback.getUTCMonth() + 1 };
};

const formatMonthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;
const roundPercent = (value: number) => Math.round(value * 10) / 10;

const formatQuantity = (value: number) => value.toLocaleString('ko-KR');

const PolicyOpsDashboard: React.FC<PolicyOpsDashboardProps> = ({ products }) => {
  const showToast = useToast();
  // Warehouse state removed
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnerLoading, setPartnerLoading] = useState(false);
  const [shipmentEvents, setShipmentEvents] = useState<ShipmentEvent[]>([]);
  const [shipmentsLoading, setShipmentsLoading] = useState(false);
  const [shipmentsReloadKey, setShipmentsReloadKey] = useState(0);
  const [isImportModalOpen, setImportModalOpen] = useState(false);

  const currentKst = useMemo(() => getCurrentKstComponents(), []);
  const [selectedYear, setSelectedYear] = useState(currentKst.year);
  const [selectedMonth, setSelectedMonth] = useState(currentKst.month);
  // Warehouse selection removed
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  // 차트 시리즈 구성 기준: 전체/연간 Top5/월 Top5
  const [seriesMode, setSeriesMode] = useState<'ALL' | 'YEAR_TOP5' | 'MONTH_TOP5'>('ALL');

  // Warehouse loading effect removed

  useEffect(() => {
    let cancelled = false;
    setPartnerLoading(true);
    listPartners({ type: 'CUSTOMER', includeSample: true })
      .then((items) => {
        if (!cancelled) {
          setPartners(items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPartners([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPartnerLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setShipmentsLoading(true);
    (async () => {
      try {
        const summaries = await listSalesOrders();
        const detailed = await Promise.all(
          summaries.map(async (summary) => {
            try {
              return await getSalesOrder(summary.id);
            } catch {
              return undefined;
            }
          }),
        );
        if (cancelled) {
          return;
        }
        const events: ShipmentEvent[] = [];
        detailed.forEach((order) => {
          if (!order?.events) {
            return;
          }
          order.events.forEach((event) => {
            if (event.kind !== 'SHIP') {
              return;
            }
            const shipEvent = event as OrderFulfillmentEvent;
            shipEvent.lines.forEach((line) => {
              if (!line || !line.sku) {
                return;
              }
              const normalizedLineSku = line.sku.trim().toUpperCase();
              const fallbackItem = order.items?.find(
                (item) => item.sku.trim().toUpperCase() === normalizedLineSku,
              );
              events.push({
                sku: line.sku,
                quantity: Math.max(0, line.quantity),
                occurredAt: shipEvent.occurredAt,
                partnerId: order.partnerId,
                warehouseCode: line.warehouseCode ?? order.warehouseCode ?? undefined,
                category: line.category,
                productName: line.productName ?? fallbackItem?.productName,
              });
            });
          });
        });
        if (!cancelled) {
          setShipmentEvents(events);
        }
      } catch {
        if (!cancelled) {
          setShipmentEvents([]);
        }
      } finally {
        if (!cancelled) {
          setShipmentsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shipmentsReloadKey]);

  const handleImportCompleted = useCallback(
    (result: ImportShipmentsResult) => {
      setShipmentsReloadKey((value) => value + 1);
      const parts = [`주문 ${result.addedOrders}건`, `라인 ${result.addedLines}행`];
      if (result.errors.length > 0) {
        parts.push(`무시 ${result.errors.length}건`);
      }
      showToast('CSV 업로드가 완료되었습니다.', {
        tone: result.errors.length > 0 ? 'info' : 'success',
        description: parts.join(' · '),
      });
    },
    [showToast],
  );

  const productBySku = useMemo(() => {
    const map = new Map<string, Product>();
    products.forEach((product) => {
      map.set(product.sku.trim().toUpperCase(), product);
    });
    return map;
  }, [products]);

  const partnerById = useMemo(() => {
    const map = new Map<string, Partner>();
    partners.forEach((partner) => {
      map.set(partner.id, partner);
    });
    return map;
  }, [partners]);

  const availableYears = useMemo(() => {
    const set = new Set<number>();
    shipmentEvents.forEach((event) => {
      const parts = getKstYearMonth(event.occurredAt);
      if (parts) {
        set.add(parts.year);
      }
    });
    if (set.size === 0) {
      set.add(currentKst.year);
    }
    return Array.from(set).sort((a, b) => b - a);
  }, [shipmentEvents, currentKst.year]);

  useEffect(() => {
    if (availableYears.length === 0) {
      return;
    }
    if (!availableYears.includes(selectedYear)) {
      setSelectedYear(availableYears[0]);
    }
  }, [availableYears, selectedYear]);

  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    products.forEach((product) => {
      if (product.category) {
        set.add(product.category);
      }
    });
    shipmentEvents.forEach((event) => {
      const normalizedSku = event.sku.trim().toUpperCase();
      if (event.category) {
        set.add(event.category);
        return;
      }
      const product = productBySku.get(normalizedSku);
      if (product?.category) {
        set.add(product.category);
      }
    });
    return Array.from(set).sort();
  }, [products, shipmentEvents, productBySku]);

  // Warehouse filter options removed

  const filteredShipments = useMemo(() => {
    return shipmentEvents.filter((event) => {
      const parts = getKstYearMonth(event.occurredAt);
      if (!parts) {
        return false;
      }
      return parts.year === selectedYear || parts.year === selectedYear - 1;
    });
  }, [selectedYear, shipmentEvents]);

  const monthlyAggregates = useMemo(() => {
    const map = new Map<string, MonthlyAggregate>();
    filteredShipments.forEach((event) => {
      const parts = getKstYearMonth(event.occurredAt);
      if (!parts) {
        return;
      }
      const key = formatMonthKey(parts.year, parts.month);
      if (!map.has(key)) {
        map.set(key, {
          total: 0,
          categoryTotals: new Map(),
          partnerTotals: new Map(),
          skuTotals: new Map(),
          events: [],
        });
      }
      const record = map.get(key)!;
      const normalizedSku = event.sku.trim().toUpperCase();
      const product = productBySku.get(normalizedSku);
      const category = event.category?.trim() || product?.category?.trim() || '기타';
      record.total += event.quantity;
      record.events.push(event);
      record.categoryTotals.set(category, (record.categoryTotals.get(category) ?? 0) + event.quantity);
      record.partnerTotals.set(event.partnerId, (record.partnerTotals.get(event.partnerId) ?? 0) + event.quantity);
      const skuEntry: SkuMonthTotal =
        record.skuTotals.get(normalizedSku) ?? {
          quantity: 0,
          category,
          names: new Map<string, number>(),
        };
      skuEntry.quantity += event.quantity;
      if (!skuEntry.category && category) {
        skuEntry.category = category;
      }
      const nameCandidate = (event.productName ?? product?.name)?.trim();
      if (nameCandidate) {
        const keyName = nameCandidate;
        skuEntry.names.set(keyName, (skuEntry.names.get(keyName) ?? 0) + event.quantity);
      }
      record.skuTotals.set(normalizedSku, skuEntry);
    });
    return map;
  }, [filteredShipments, productBySku]);

  const selectedMonthKey = formatMonthKey(selectedYear, selectedMonth);
  const monthRecord = monthlyAggregates.get(selectedMonthKey);
  const monthCategoryTotals = monthRecord?.categoryTotals ?? new Map<string, number>();
  // 연간 고정 시리즈 계산을 위해: 해당 연도 전체의 카테고리 합계
  const yearCategoryTotals = useMemo(() => {
    const totals = new Map<string, number>();
    monthNumbers.forEach((month) => {
      const record = monthlyAggregates.get(formatMonthKey(selectedYear, month));
      if (!record) return;
      record.categoryTotals.forEach((value, category) => {
        totals.set(category, (totals.get(category) ?? 0) + value);
      });
    });
    return totals;
  }, [monthlyAggregates, selectedYear]);

  const getTotalForKey = useCallback(
    (key: string) => {
      const record = monthlyAggregates.get(key);
      if (!record) {
        return 0;
      }
      if (selectedCategory === 'all') {
        return record.total;
      }
      return record.categoryTotals.get(selectedCategory) ?? 0;
    },
    [monthlyAggregates, selectedCategory],
  );

  const monthsWithData = useMemo(() => {
    return monthNumbers.filter((month) => {
      const key = formatMonthKey(selectedYear, month);
      return getTotalForKey(key) > 0;
    });
  }, [getTotalForKey, selectedYear]);

  useEffect(() => {
    if (monthsWithData.length === 0) {
      return;
    }
    if (monthsWithData.includes(selectedMonth)) {
      return;
    }
    setSelectedMonth(monthsWithData[monthsWithData.length - 1]);
  }, [monthsWithData, selectedMonth]);

  const chartCategoryOrder = useMemo(() => {
    if (selectedCategory !== 'all') {
      return [selectedCategory];
    }
    if (seriesMode === 'MONTH_TOP5') {
      return Array.from(monthCategoryTotals.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, CATEGORY_TOP_COUNT)
        .map(([category]) => category);
    }
    if (seriesMode === 'YEAR_TOP5') {
      return Array.from(yearCategoryTotals.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, CATEGORY_TOP_COUNT)
        .map(([category]) => category);
    }
    // 'ALL' 모드: 사용자/엑셀 등록 카테고리 전체를 출고량(연간) 내림차순으로 정렬
    return [...categoryOptions].sort(
      (a, b) => (yearCategoryTotals.get(b) ?? 0) - (yearCategoryTotals.get(a) ?? 0) || a.localeCompare(b),
    );
  }, [categoryOptions, monthCategoryTotals, selectedCategory, seriesMode, yearCategoryTotals]);

  const stackedKeys = useMemo(() => {
    if (selectedCategory !== 'all') {
      return [selectedCategory];
    }
    // 전체 카테고리 모드에서는 '기타'를 사용하지 않음
    if (seriesMode === 'ALL') {
      return [...chartCategoryOrder];
    }
    const keys = [...chartCategoryOrder];
    const baseTotals = seriesMode === 'MONTH_TOP5' ? monthCategoryTotals : yearCategoryTotals;
    const hasOther = Array.from(baseTotals.entries()).some(
      ([category, value]) => value > 0 && !chartCategoryOrder.includes(category),
    );
    if (hasOther) keys.push('기타');
    return keys;
  }, [chartCategoryOrder, monthCategoryTotals, selectedCategory, seriesMode, yearCategoryTotals]);

  const chartData = useMemo(() => {
    return monthNumbers.map((month) => {
      const key = formatMonthKey(selectedYear, month);
      const record = monthlyAggregates.get(key);
      const entry: Record<string, number | string | null> = {
        monthLabel: `${month}월`,
      };
      let totalForMonth = getTotalForKey(key);
      stackedKeys.forEach((category) => {
        if (category === '기타') {
          if (selectedCategory !== 'all' || !record) {
            entry[category] = 0;
            return;
          }
          let otherTotal = 0;
          record.categoryTotals.forEach((value, current) => {
            if (!chartCategoryOrder.includes(current)) {
              otherTotal += value;
            }
          });
          entry[category] = otherTotal;
        } else {
          const value =
            selectedCategory === 'all'
              ? record?.categoryTotals.get(category) ?? 0
              : record?.categoryTotals.get(category) ?? 0;
          entry[category] = value;
          if (selectedCategory !== 'all') {
            totalForMonth = value;
          }
        }
      });
      entry.total = totalForMonth;
      const prevKey = month === 1 ? formatMonthKey(selectedYear - 1, 12) : formatMonthKey(selectedYear, month - 1);
      const prevTotal = getTotalForKey(prevKey);
      entry.mom = prevTotal > 0 ? roundPercent(((totalForMonth - prevTotal) / prevTotal) * 100) : null;
      const yoyKey = formatMonthKey(selectedYear - 1, month);
      const yoyTotal = getTotalForKey(yoyKey);
      entry.yoy = yoyTotal > 0 ? roundPercent(((totalForMonth - yoyTotal) / yoyTotal) * 100) : null;
      return entry;
    });
  }, [chartCategoryOrder, getTotalForKey, monthlyAggregates, selectedCategory, selectedYear, stackedKeys]);

  const momTrendAvailable = useMemo(() => {
    return monthNumbers.some((month) => {
      const key = formatMonthKey(selectedYear, month);
      const prevKey =
        month === 1 ? formatMonthKey(selectedYear - 1, 12) : formatMonthKey(selectedYear, month - 1);
      return getTotalForKey(key) > 0 && getTotalForKey(prevKey) > 0;
    });
  }, [getTotalForKey, selectedYear]);

  const yoyTrendAvailable = useMemo(() => {
    return monthNumbers.some((month) => {
      const key = formatMonthKey(selectedYear, month);
      const yoyKey = formatMonthKey(selectedYear - 1, month);
      return getTotalForKey(key) > 0 && getTotalForKey(yoyKey) > 0;
    });
  }, [getTotalForKey, selectedYear]);

  const showTrendAxis = momTrendAvailable || yoyTrendAvailable;

  const monthPartnerTotals = monthRecord?.partnerTotals ?? new Map<string, number>();
  const monthSkuTotals = monthRecord?.skuTotals ?? new Map<string, SkuMonthTotal>();
  const monthTotalQuantity = Array.from(monthSkuTotals.values()).reduce(
    (sum, entry) => sum + entry.quantity,
    0,
  );
  const isMonthDataEmpty = monthTotalQuantity === 0;

  const topCategories = useMemo(() => {
    return Array.from(monthCategoryTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, CATEGORY_TOP_COUNT)
      .map(([category, value]) => ({ category, value }));
  }, [monthCategoryTotals]);

  const partnerRows = useMemo(() => {
    return Array.from(monthPartnerTotals.entries())
      .map(([partnerId, qty]) => ({
        partnerId,
        name: partnerById.get(partnerId)?.name ?? '미지정',
        quantity: qty,
      }))
      .sort(
        (a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name),
      )
      .slice(0, 5);
  }, [monthPartnerTotals, partnerById]);

  const resolveSkuDisplayName = (sku: string, info: SkuMonthTotal) => {
    const product = productBySku.get(sku);
    // Prefer catalog product name if available
    if (product?.name && product.name.trim()) {
      return product.name;
    }
    // Otherwise pick the most frequent observed name for this month
    let bestName: string | undefined;
    let bestQty = -1;
    info.names.forEach((qty, label) => {
      if (qty > bestQty) {
        bestQty = qty;
        bestName = label;
      }
    });
    return bestName;
  };

  const skuRows = useMemo(() => {
    return Array.from(monthSkuTotals.entries())
      .map(([sku, info]) => ({
        sku,
        product: productBySku.get(sku),
        productName: resolveSkuDisplayName(sku, info) ?? productBySku.get(sku)?.name,
        quantity: info.quantity,
      }))
      .sort(
        (a, b) =>
          b.quantity - a.quantity ||
          (a.productName ?? a.product?.name ?? a.sku).localeCompare(
            b.productName ?? b.product?.name ?? b.sku,
          ),
      )
      .slice(0, 5);
  }, [monthSkuTotals, productBySku]);

  // Top5 SKU 집합 (Worst5에서 제외하기 위함)
  const topSkuSet = useMemo(() => new Set(skuRows.map((r) => r.sku)), [skuRows]);

  const worstSkuRows = useMemo(() => {
    if (isMonthDataEmpty) {
      return [];
    }

    // 1) 이번 달 출고 SKU 중 Top5 제외 + 카테고리 필터 반영
    const shippedCandidates = Array.from(monthSkuTotals.entries())
      .map(([sku, info]) => ({
        sku,
        product: productBySku.get(sku),
        productName: resolveSkuDisplayName(sku, info) ?? productBySku.get(sku)?.name,
        quantity: info.quantity,
        category: info.category ?? productBySku.get(sku)?.category,
      }))
      .filter(
        (row) =>
          row.quantity > 0 &&
          !topSkuSet.has(row.sku) &&
          (selectedCategory === 'all' || row.category === selectedCategory),
      )
      .sort(
        (a, b) =>
          a.quantity - b.quantity ||
          (a.productName ?? a.product?.name ?? a.sku).localeCompare(
            b.productName ?? b.product?.name ?? b.sku,
          ),
      );

    if (shippedCandidates.length === 0) {
      return [];
    }

    return shippedCandidates.slice(0, 5);
  }, [isMonthDataEmpty, monthSkuTotals, productBySku, selectedCategory, topSkuSet]);

  const selectedMonthLabel = `${selectedYear}년 ${selectedMonth}월`;
  const loading = shipmentsLoading || partnerLoading;
  const worstPlaceholderMessage = isMonthDataEmpty
    ? '데이터 없음 · CSV 업로드로 시작하세요.'
    : '데이터 없음';

  return (
    <>
      <section className="space-y-6">
        <Card className="space-y-4">
          <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">정책 기반 운영 통계</p>
              <h2 className="text-xl font-bold text-slate-900">출고 흐름 & 상위 실적</h2>
              <p className="text-sm text-slate-500">예측 기준 점검 전에 출고 추세와 주요 기여도를 검토하세요.</p>
            </div>
            <div className="flex flex-col items-start gap-2 text-xs text-slate-500 md:items-end">
              {loading && <span>데이터를 불러오는 중입니다...</span>}
              <div className="flex flex-wrap gap-2">
                <a
                  href={SHIPMENTS_TEMPLATE_URL}
                  download
                  className="rounded-md border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
                >
                  CSV 템플릿
                </a>
                <button
                  type="button"
                  onClick={() => setImportModalOpen(true)}
                  className="rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-700"
                >
                  CSV 업로드
                </button>
              </div>
            </div>
          </header>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col text-sm text-slate-600">
              <span className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">연도</span>
              <select
                className="rounded-xl border border-slate-200 px-3 py-2"
                value={selectedYear}
                onChange={(event) => setSelectedYear(Number(event.target.value))}
              >
                {availableYears.map((year) => (
                  <option key={year} value={year}>
                    {year}년
                  </option>
                ))}
              </select>
          </label>
            <label className="flex flex-col text-sm text-slate-600">
              <span className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">카테고리</span>
              <select
                className="rounded-xl border border-slate-200 px-3 py-2"
                value={selectedCategory}
                onChange={(event) => setSelectedCategory(event.target.value)}
              >
                <option value="all">전체 카테고리</option>
                {categoryOptions.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-sm text-slate-600">
              <span className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">월</span>
              <select
                className="rounded-xl border border-slate-200 px-3 py-2"
                value={selectedMonth}
                onChange={(event) => setSelectedMonth(Number(event.target.value))}
              >
                {monthNumbers.map((month) => (
                  <option key={month} value={month}>
                    {month}월
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-sm text-slate-600">
              <span className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">시리즈 기준</span>
              <select
                className="rounded-xl border border-slate-200 px-3 py-2"
                value={seriesMode}
                onChange={(e) => setSeriesMode(e.target.value as 'ALL' | 'YEAR_TOP5' | 'MONTH_TOP5')}
              >
                <option value="ALL">전체 카테고리(출고량 순)</option>
                <option value="YEAR_TOP5">연간 Top5 + 기타</option>
                <option value="MONTH_TOP5">선택 월 Top5 + 기타</option>
              </select>
            </label>
          </div>
          
          <div className="h-72 w-full">
          {stackedKeys.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">
              표시할 출고 데이터가 없습니다.
            </div>
          ) : (
            <ShipmentFlowChart
              data={chartData}
              categories={stackedKeys}
              palette={barPalette}
              momAvailable={momTrendAvailable}
              yoyAvailable={yoyTrendAvailable}
            />
          )}
        </div>
        </Card>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
        <Card className="space-y-4">
          <header className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">{selectedMonthLabel}</p>
              <h3 className="text-lg font-semibold text-slate-900">거래처별 Top5</h3>
            </div>
            <span className="text-xs text-slate-500">고객 기준</span>
          </header>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">거래처</th>
                  <th className="px-3 py-2 text-right">출고량</th>
                </tr>
              </thead>
              <tbody>
                {partnerRows.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-3 py-8 text-center text-slate-400">
                      데이터 없음
                    </td>
                  </tr>
                ) : (
                  partnerRows.map((row) => (
                    <tr key={row.partnerId} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-800">{row.name}</td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-900">
                        {formatQuantity(row.quantity)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
        <Card className="space-y-4">
          <header className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">{selectedMonthLabel}</p>
              <h3 className="text-lg font-semibold text-slate-900">카테고리 Top5</h3>
            </div>
          </header>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">카테고리</th>
                  <th className="px-3 py-2 text-right">출고량</th>
                  <th className="px-3 py-2 text-right">비중</th>
                </tr>
              </thead>
              <tbody>
                {topCategories.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-8 text-center text-slate-400">
                      데이터 없음
                    </td>
                  </tr>
                ) : (
                  topCategories.map((row) => (
                    <tr key={row.category} className="border-t border-slate-100">
                      <td className="px-3 py-2">{row.category}</td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-900">
                        {formatQuantity(row.value)}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-600">
                        {monthTotalQuantity > 0 ? `${roundPercent((row.value / monthTotalQuantity) * 100)}%` : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
        <Card className="space-y-4">
          <header className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">{selectedMonthLabel}</p>
              <h3 className="text-lg font-semibold text-slate-900">이달 Top5 SKU</h3>
            </div>
          </header>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">품명</th>
                  <th className="px-3 py-2 text-right">출고량</th>
                </tr>
              </thead>
              <tbody>
                {skuRows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-8 text-center text-slate-400">
                      데이터 없음
                    </td>
                  </tr>
                ) : (
                  skuRows.map((row) => (
                    <tr key={row.sku} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">{row.sku}</td>
                      <td className="px-3 py-2 text-slate-800">{row.productName ?? row.product?.name ?? row.sku}</td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-900">
                        {formatQuantity(row.quantity)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
        <Card className="space-y-4 md:col-span-2 xl:col-span-1">
          <header className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">{selectedMonthLabel}</p>
              <h3 className="text-lg font-semibold text-slate-900">이달 Worst5 SKU</h3>
            </div>
            <span className="text-xs text-slate-500">
              {selectedCategory === 'all' ? '전체 품목 기준' : `${selectedCategory} 기준`}
            </span>
          </header>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">품명</th>
                  <th className="px-3 py-2 text-right">출고량</th>
                </tr>
              </thead>
              <tbody>
                {worstSkuRows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-8 text-center text-slate-400">
                      {worstPlaceholderMessage}
                    </td>
                  </tr>
                ) : (
                  worstSkuRows.map((row) => (
                    <tr key={row.sku} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">{row.sku}</td>
                      <td className="px-3 py-2 text-slate-800">{row.productName ?? row.product?.name ?? row.sku}</td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-900">
                        {formatQuantity(row.quantity)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      </section>
      <ImportShipmentsModal
        isOpen={isImportModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImported={handleImportCompleted}
      />
    </>
  );
};

export default PolicyOpsDashboard;
