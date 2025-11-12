import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Modal from '@/components/ui/Modal';
import { ko } from '@/src/i18n/ko';
import PurchaseOrderDateRangePicker from '@/src/app/components/PurchaseOrderDateRangePicker';
import {
  buildRangeForPreset,
  buildRangeFromDateStrings,
  type DateRange,
  type KstRangePreset,
  MAX_PURCHASE_ORDER_RANGE_DAYS,
  MAX_PURCHASE_ORDER_RANGE_MS,
  KST_RANGE_PRESETS,
} from '@/shared/datetime/ranges';
import { deletePurchaseOrder, listPurchaseOrders, type PurchaseOrder } from '../../../../services/purchaseOrders';
import { getPurchaseStatusLabel } from '../../../utils/purchaseStatus';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const formatDate = (value: string | null): string => (value ? new Date(value).toLocaleDateString() : '—');

const toKstDateString = (iso: string): string => {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return '';
  }
  const shifted = new Date(timestamp + KST_OFFSET_MS);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const toKstDayIndex = (timestamp: number): number => Math.floor((timestamp + KST_OFFSET_MS) / MS_PER_DAY);

const getPurchaseOrderDayDiff = (isoDate: string | null, todayIndex: number): number | null => {
  if (!isoDate) {
    return null;
  }
  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return toKstDayIndex(timestamp) - todayIndex;
};

const getEarliestRemainingPromisedDate = (order: PurchaseOrder): string | null => {
  const candidates: Array<{ iso: string; timestamp: number }> = [];
  order.lines.forEach((line) => {
    const remaining = Math.max(0, line.orderedQty - line.receivedQty);
    if (remaining <= 0) {
      return;
    }
    const plannedDate = line.promisedDate ?? order.promisedDate;
    if (!plannedDate) {
      return;
    }
    const timestamp = Date.parse(plannedDate);
    if (Number.isNaN(timestamp)) {
      return;
    }
    candidates.push({ iso: plannedDate, timestamp });
  });
  if (candidates.length === 0) {
    if (!order.promisedDate) {
      return null;
    }
    const fallbackTimestamp = Date.parse(order.promisedDate);
    return Number.isNaN(fallbackTimestamp) ? null : order.promisedDate;
  }
  const earliest = candidates.reduce((prev, current) =>
    current.timestamp < prev.timestamp ? current : prev,
  );
  return earliest.iso;
};

type ArrivalFilterScope = 'all' | 'overdue' | 'today' | 'next3';
type ArrivalTargetScope = Exclude<ArrivalFilterScope, 'all'>;
type OrderDueState = ArrivalFilterScope | 'future' | 'completed' | 'canceled';

const determineOrderDueState = (
  dayDiff: number | null,
  remaining: number,
  status: PurchaseOrder['status'],
): OrderDueState => {
  if (status === 'canceled') {
    return 'canceled';
  }
  if (remaining <= 0) {
    return 'completed';
  }
  if (dayDiff === null) {
    return 'future';
  }
  if (dayDiff < 0) {
    return 'overdue';
  }
  if (dayDiff === 0) {
    return 'today';
  }
  if (dayDiff <= 3) {
    return 'next3';
  }
  return 'future';
};

type PurchaseTab = 'all' | 'draft' | 'awaiting' | 'partial' | 'received';
type PurchaseOrderTabCategory = Exclude<PurchaseTab, 'all'> | 'excluded';

type EnhancedPurchaseOrder = PurchaseOrder & {
  totalOrdered: number;
  totalReceived: number;
  remaining: number;
  dday: number | null;
  dueState: OrderDueState;
  tabCategory: PurchaseOrderTabCategory;
};

interface ArrivalCategory {
  scope: ArrivalTargetScope;
  title: string;
  description: string;
  count: number;
}

const formatDdayLabel = (dayDiff: number | null): string => {
  if (dayDiff === null) {
    return '—';
  }
  if (dayDiff === 0) {
    return 'D-0';
  }
  if (dayDiff > 0) {
    return `D-${dayDiff}`;
  }
  return `D+${Math.abs(dayDiff)}`;
};

const getDdayBadgeClass = (dayDiff: number | null): string => {
  if (dayDiff === null) {
    return 'bg-slate-100 text-slate-600';
  }
  if (dayDiff < 0) {
    return 'bg-rose-100 text-rose-600';
  }
  if (dayDiff === 0) {
    return 'bg-sky-100 text-sky-700';
  }
  if (dayDiff <= 3) {
    return 'bg-amber-100 text-amber-700';
  }
  return 'bg-slate-100 text-slate-700';
};

const determineTabCategory = (
  status: PurchaseOrder['status'],
  remaining: number,
  totalReceived: number,
): PurchaseOrderTabCategory => {
  if (status === 'draft') {
    return 'draft';
  }
  if (status === 'canceled') {
    return 'excluded';
  }
  if (remaining <= 0) {
    return 'received';
  }
  if (totalReceived <= 0) {
    return 'awaiting';
  }
  return 'partial';
};

const FILTER_PARAM = 'poFilter';
const FILTER_VALUE = 'date';
const RANGE_FROM_PARAM = 'poFrom';
const RANGE_TO_PARAM = 'poTo';
const PRESET_PARAM = 'poPreset';

const PRESET_KEYS = new Set<KstRangePreset>(KST_RANGE_PRESETS);
const isPresetParam = (value: string | null): value is KstRangePreset =>
  value !== null && PRESET_KEYS.has(value as KstRangePreset);

const PurchasePage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualRange, setManualRange] = useState({ from: '', to: '' });
  const [manualError, setManualError] = useState<string | null>(null);
  const [arrivalFilter, setArrivalFilter] = useState<ArrivalFilterScope>('all');
  const [activeTab, setActiveTab] = useState<PurchaseTab>('all');
  const [orderToDelete, setOrderToDelete] = useState<EnhancedPurchaseOrder | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const filterPanelOpen = searchParams.get(FILTER_PARAM) === FILTER_VALUE;
  const presetParam = searchParams.get(PRESET_PARAM);
  const manualFromParam = searchParams.get(RANGE_FROM_PARAM);
  const manualToParam = searchParams.get(RANGE_TO_PARAM);

  const activeRange = useMemo(() => {
    if (isPresetParam(presetParam)) {
      return buildRangeForPreset(presetParam);
    }
    if (manualFromParam && manualToParam) {
      return buildRangeFromDateStrings(manualFromParam, manualToParam);
    }
    return null;
  }, [manualFromParam, manualToParam, presetParam]);

  const activePreset: 'all' | KstRangePreset | 'custom' = useMemo(() => {
    if (isPresetParam(presetParam)) {
      return presetParam;
    }
    if (activeRange && manualFromParam && manualToParam) {
      return 'custom';
    }
    return 'all';
  }, [activeRange, manualFromParam, presetParam]);

  const fetchOrders = useCallback(async (range?: DateRange | null) => {
    setLoading(true);
    setError(null);
    try {
      const response = await listPurchaseOrders(
        range ? { from: range.from, to: range.to } : undefined,
      );
      setOrders(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : '불러오는 중 오류 발생');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchOrders(activeRange);
  }, [activeRange, fetchOrders]);

  useEffect(() => {
    if (!filterPanelOpen) {
      return;
    }
    if (activeRange) {
      setManualRange({
        from: toKstDateString(activeRange.from),
        to: toKstDateString(activeRange.to),
      });
      setManualError(null);
      return;
    }
    setManualRange({
      from: manualFromParam ?? '',
      to: manualToParam ?? '',
    });
    setManualError(null);
  }, [activeRange, filterPanelOpen, manualFromParam, manualToParam]);

  const manualCandidate = buildRangeFromDateStrings(manualRange.from, manualRange.to);
  const manualDurationMs =
    manualCandidate !== null
      ? Date.parse(manualCandidate.to) - Date.parse(manualCandidate.from)
      : 0;
  const isManualValid = Boolean(
    manualCandidate && manualDurationMs <= MAX_PURCHASE_ORDER_RANGE_MS,
  );

  const handlePresetSelect = (preset: KstRangePreset | 'all') => {
    const next = new URLSearchParams(searchParams);
    next.delete(FILTER_PARAM);
    next.delete(RANGE_FROM_PARAM);
    next.delete(RANGE_TO_PARAM);
    if (preset === 'all') {
      next.delete(PRESET_PARAM);
    } else {
      next.set(PRESET_PARAM, preset);
    }
    setSearchParams(next);
  };

  const handleManualApply = () => {
    if (!manualCandidate) {
      setManualError(ko.purchaseOrders.filter.errors.invalidRange);
      return;
    }

    if (manualDurationMs > MAX_PURCHASE_ORDER_RANGE_MS) {
      setManualError(ko.purchaseOrders.filter.errors.limitExceeded);
      return;
    }

    const next = new URLSearchParams(searchParams);
    next.set(RANGE_FROM_PARAM, manualRange.from);
    next.set(RANGE_TO_PARAM, manualRange.to);
    next.delete(PRESET_PARAM);
    next.delete(FILTER_PARAM);
    setSearchParams(next);
  };

  const handleManualChange = (range: { from: string; to: string }) => {
    setManualRange(range);
    setManualError(null);
  };

  const handleClearFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete(RANGE_FROM_PARAM);
    next.delete(RANGE_TO_PARAM);
    next.delete(PRESET_PARAM);
    next.delete(FILTER_PARAM);
    setSearchParams(next);
  };

  const rangeSummary = useMemo(
    () =>
      activeRange
        ? `${toKstDateString(activeRange.from)} ~ ${toKstDateString(activeRange.to)}`
        : ko.purchaseOrders.filter.summaryEmpty,
    [activeRange],
  );

  const openFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.set(FILTER_PARAM, FILTER_VALUE);
    setSearchParams(next);
  };

  const closeFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete(FILTER_PARAM);
    setSearchParams(next);
  };

  const openCreatePage = () => {
    navigate('/purchase-orders/new');
  };

  const openDetailPage = (orderId: string) => {
    const path = `/purchase-orders/${encodeURIComponent(orderId)}`;
    navigate(path);
  };

  const openDeleteModal = (order: EnhancedPurchaseOrder) => {
    setOrderToDelete(order);
    setDeleteError(null);
  };

  const closeDeleteModal = () => {
    if (isDeleting) {
      return;
    }
    setOrderToDelete(null);
    setDeleteError(null);
  };

  const handleConfirmDelete = async () => {
    if (!orderToDelete) {
      return;
    }
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await deletePurchaseOrder(orderToDelete.id);
      setOrders((prev) => prev.filter((entry) => entry.id !== orderToDelete.id));
      setOrderToDelete(null);
    } catch (deleteErr) {
      const message =
        deleteErr instanceof Error
          ? deleteErr.message
          : '삭제에 실패했습니다. 다시 시도해 주세요.';
      setDeleteError(message);
    } finally {
      setIsDeleting(false);
    }
  };

  const processedOrders = useMemo<EnhancedPurchaseOrder[]>(() => {
    const todayIndex = toKstDayIndex(Date.now());
    return orders.map((order) => {
      const totalOrdered = order.lines.reduce((sum, line) => sum + line.orderedQty, 0);
      const totalReceived = order.lines.reduce((sum, line) => sum + line.receivedQty, 0);
      const remaining = Math.max(0, totalOrdered - totalReceived);
      const plannedDateForRemaining = remaining > 0 ? getEarliestRemainingPromisedDate(order) : null;
      const dday =
        remaining > 0 ? getPurchaseOrderDayDiff(plannedDateForRemaining, todayIndex) : null;
      const dueState = determineOrderDueState(dday, remaining, order.status);
      return {
        ...order,
        totalOrdered,
        totalReceived,
        remaining,
        dday,
        dueState,
        tabCategory: determineTabCategory(order.status, remaining, totalReceived),
      };
    });
  }, [orders]);

  const arrivalSummary = useMemo(
    () => {
      const summary = { overdue: 0, today: 0, next3: 0, pending: 0 };
      processedOrders.forEach((entry) => {
      if (entry.remaining <= 0 || entry.status === 'canceled' || entry.tabCategory === 'draft') {
        return;
      }
      summary.pending += 1;
        if (entry.dueState === 'overdue') {
          summary.overdue += 1;
        } else if (entry.dueState === 'today') {
          summary.today += 1;
        } else if (entry.dueState === 'next3') {
          summary.next3 += 1;
        }
      });
      return summary;
    },
    [processedOrders],
  );

  const tabCounts = useMemo<Record<PurchaseTab, number>>(() => {
    const counts: Record<PurchaseTab, number> = {
      all: 0,
      draft: 0,
      awaiting: 0,
      partial: 0,
      received: 0,
    };
    processedOrders.forEach((order) => {
      if (order.tabCategory === 'excluded') {
        return;
      }
      if (order.tabCategory === 'draft') {
        counts.draft += 1;
        return;
      }
      counts[order.tabCategory] += 1;
    });
    counts.all = counts.awaiting + counts.partial + counts.received + counts.draft;
    return counts;
  }, [processedOrders]);

  const purchaseTabs: Array<{ key: PurchaseTab; label: string }> = [
    { key: 'all', label: ko.purchaseOrders.tabs.labels.all },
    { key: 'draft', label: ko.purchaseOrders.tabs.labels.draft },
    { key: 'awaiting', label: ko.purchaseOrders.tabs.labels.awaiting },
    { key: 'partial', label: ko.purchaseOrders.tabs.labels.partial },
    { key: 'received', label: ko.purchaseOrders.tabs.labels.received },
  ];

  const filteredOrders = useMemo(() => {
    return processedOrders.filter((order) => {
      const matchesTab =
        activeTab === 'all' ? order.tabCategory !== 'excluded' : order.tabCategory === activeTab;

      if (!matchesTab) {
        return false;
      }

      if (order.tabCategory === 'draft') {
        return activeTab === 'draft' || arrivalFilter === 'all';
      }

      if (arrivalFilter === 'all') {
        return true;
      }

      if (order.remaining <= 0 || order.status === 'canceled') {
        return false;
      }

      return order.dueState === arrivalFilter;
    });
  }, [arrivalFilter, activeTab, processedOrders]);

  const pendingCount = arrivalSummary.pending;
  const arrivalCategories: ArrivalCategory[] = [
    {
      scope: 'overdue',
      title: ko.purchaseOrders.arrival.cards.overdue.title,
      description: ko.purchaseOrders.arrival.cards.overdue.description,
      count: arrivalSummary.overdue,
    },
    {
      scope: 'today',
      title: ko.purchaseOrders.arrival.cards.today.title,
      description: ko.purchaseOrders.arrival.cards.today.description,
      count: arrivalSummary.today,
    },
    {
      scope: 'next3',
      title: ko.purchaseOrders.arrival.cards.next3.title,
      description: ko.purchaseOrders.arrival.cards.next3.description,
      count: arrivalSummary.next3,
    },
  ];
  const isArrivalFilterActive = arrivalFilter !== 'all';
  const hasVisibleOrders = processedOrders.some((entry) => entry.tabCategory !== 'excluded');
  const hasFilteredOrders = filteredOrders.length > 0;
  const emptyMessage =
    activeTab !== 'draft' && arrivalFilter !== 'all'
      ? ko.purchaseOrders.arrival.empty
      : ko.purchaseOrders.tabs.empty;
  const shouldShowEmptyMessage = hasVisibleOrders && !hasFilteredOrders;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">구매 발주서</h2>
          <p className="text-sm text-slate-500">입고 주문서와 연계하기 위한 기본 목록입니다.</p>
        </div>
        <button
          type="button"
          onClick={openCreatePage}
          className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700"
        >
          새 발주서 작성
        </button>
      </div>

      <div className="border-b border-slate-100 pb-3">
        <div
          className="flex flex-wrap gap-6 text-sm font-semibold text-slate-600"
          role="tablist"
          aria-label="발주 상태"
        >
          {purchaseTabs.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.key)}
                className={`inline-flex items-center gap-2 pb-3 transition ${
                  isActive
                    ? 'border-b-2 border-indigo-600 text-indigo-600'
                    : 'border-b-2 border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-200'
                }`}
              >
                <span>{tab.label}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                  {tabCounts[tab.key].toLocaleString('ko-KR')}건
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white/80 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-400">
              {ko.purchaseOrders.arrival.panelLabel}
            </p>
            <p className="text-sm font-semibold text-slate-900">
              {ko.purchaseOrders.arrival.panelDescription}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs text-slate-500">
              {pendingCount > 0
                ? ko.purchaseOrders.arrival.pendingCount(pendingCount)
                : ko.purchaseOrders.arrival.pendingEmpty}
            </div>
            <button
              type="button"
              onClick={() => setArrivalFilter('all')}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                isArrivalFilterActive
                  ? 'border-indigo-400 text-indigo-600 hover:border-indigo-500'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300'
              }`}
            >
              {ko.purchaseOrders.arrival.actions.reset}
            </button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {arrivalCategories.map((entry) => (
            <button
              type="button"
              key={entry.scope}
              onClick={() => setArrivalFilter(entry.scope)}
              className={`flex flex-col gap-2 rounded-2xl border px-3 py-3 text-left transition ${
                arrivalFilter === entry.scope
                  ? 'border-indigo-400 bg-indigo-50 shadow-[0_5px_25px_rgba(99,102,241,0.25)]'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
              aria-pressed={arrivalFilter === entry.scope}
            >
              <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-slate-400">
                {entry.title}
              </p>
              <p className="text-2xl font-semibold text-slate-900">{entry.count.toLocaleString('ko-KR')}건</p>
              <p className="text-xs text-slate-500">{entry.description}</p>
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-500">{ko.purchaseOrders.arrival.helper}</p>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white/80 px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-400">
              {ko.purchaseOrders.filter.label}
            </p>
            <p className="text-sm font-semibold text-slate-900">{rangeSummary}</p>
          </div>
          <div className="flex items-center gap-2">
            {activeRange ? (
              <button
                type="button"
                onClick={handleClearFilter}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
              >
                {ko.purchaseOrders.filter.actions.clear}
              </button>
            ) : null}
            <button
              type="button"
              onClick={openFilter}
              className="rounded-full border border-slate-200 px-4 py-1 text-xs font-semibold uppercase tracking-[0.3em] text-slate-600 transition hover:border-indigo-400 hover:text-indigo-600"
            >
              {ko.purchaseOrders.filter.actions.open}
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white/80 p-4">
        {error ? (
          <p className="text-sm text-rose-500">{error}</p>
        ) : loading ? (
          <p className="text-sm text-slate-500">불러오는 중…</p>
        ) : !hasVisibleOrders ? (
          <p className="text-sm text-slate-500">등록된 발주서가 없습니다.</p>
        ) : shouldShowEmptyMessage ? (
          <p className="text-sm text-slate-500">{emptyMessage}</p>
        ) : (
          <div className="overflow-hidden rounded-2xl border">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">번호</th>
                  <th className="px-4 py-3">공급사</th>
                  <th className="px-4 py-3">상태</th>
                  <th className="px-4 py-3">총 요청</th>
                  <th className="px-4 py-3">입고</th>
                  <th className="px-4 py-3">입고 D-Day</th>
                  <th className="px-4 py-3">입고일</th>
                  <th className="px-4 py-3 text-right">작업</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((order) => (
                  <tr
                    key={order.id}
                    className="border-t border-slate-100 cursor-pointer hover:bg-slate-50 transition-colors"
                    onClick={() => openDetailPage(order.id)}
                  >
                    <td className="px-4 py-3 font-medium">{order.orderNumber || order.id}</td>
                    <td className="px-4 py-3">{order.vendorName || order.vendorId}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${badgeClass(order.status)}`}>
                        {getPurchaseStatusLabel(order.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3">{order.totalOrdered.toLocaleString('ko-KR')} EA</td>
                    <td className="px-4 py-3 text-slate-600">
                      {order.totalReceived.toLocaleString('ko-KR')} / {order.totalOrdered.toLocaleString('ko-KR')}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        {order.remaining > 0 ? (
                          <span
                            className={`inline-flex w-fit rounded-full px-3 py-0.5 text-xs font-semibold ${getDdayBadgeClass(
                              order.dday,
                            )}`}
                          >
                            {formatDdayLabel(order.dday)}
                          </span>
                        ) : (
                          <span className="text-xs font-semibold text-slate-400">—</span>
                        )}
                        <span className="text-xs text-slate-500">
                          {order.remaining > 0
                            ? `${order.remaining.toLocaleString('ko-KR')} EA 남음`
                            : '잔량 없음'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">{formatDate(order.promisedDate)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        aria-label={`발주서 ${order.orderNumber || order.id} 삭제`}
                        onClick={(event) => {
                          event.stopPropagation();
                          openDeleteModal(order);
                        }}
                        className="rounded-full border border-rose-100 bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700 transition hover:border-rose-200 hover:bg-rose-100"
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>

    <Modal isOpen={Boolean(orderToDelete)} onClose={closeDeleteModal} title="발주서 삭제">
      <p className="text-sm text-slate-700">
        {orderToDelete
          ? `${orderToDelete.orderNumber || orderToDelete.id} 발주서를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.`
          : '삭제할 발주서를 선택해 주세요.'}
      </p>
      {deleteError && <p className="mt-3 text-sm text-rose-600">{deleteError}</p>}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleConfirmDelete}
          disabled={isDeleting}
          className="rounded-full bg-rose-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isDeleting ? '삭제 중…' : '확인'}
        </button>
        <button
          type="button"
          onClick={closeDeleteModal}
          disabled={isDeleting}
          className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          취소
        </button>
      </div>
    </Modal>

    <PurchaseOrderDateRangePicker
      isOpen={filterPanelOpen}
      onClose={closeFilter}
      onPresetSelect={handlePresetSelect}
      manualFrom={manualRange.from}
      manualTo={manualRange.to}
      onManualChange={handleManualChange}
      onApply={handleManualApply}
      isManualValid={isManualValid}
      validationMessage={manualError}
      activePreset={activePreset}
      maxRangeDays={MAX_PURCHASE_ORDER_RANGE_DAYS}
    />
    </div>
  );
};

const badgeClass = (status: PurchaseOrder['status']) => {
  switch (status) {
    case 'draft':
      return 'bg-sky-100 text-sky-700';
    case 'closed':
      return 'bg-emerald-100 text-emerald-700';
    case 'partial':
      return 'bg-amber-100 text-amber-700';
    case 'canceled':
      return 'bg-red-100 text-red-600';
    default:
      return 'bg-slate-100 text-slate-700';
  }
};

export default PurchasePage;
