import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { listPartners, type Partner } from '../../../services/orders';
import { getPurchaseOrder, type PurchaseOrder } from '../../../services/purchaseOrders';
import {
  listMovements,
  submitMovement,
  type CreateMovementPayload,
  type MovementSummary,
} from '../../../services/movements';
import {
  fetchLocations,
  fetchWarehouses,
  type ApiLocation,
  type ApiWarehouse,
} from '../../../services/api';
import { formatKstDateTimeLabelFromUtc } from '@/shared/datetime/kst';
import { formatCurrency } from '@/src/utils/format';
import Modal from '@/components/ui/Modal';
import { getPurchaseStatusLabel } from '../../utils/purchaseStatus';
import { useToast } from '@/src/components/Toaster';

type TabKey = 'items' | 'receipts';

const formatDateLabel = (value: string | undefined | null) => {
  if (!value) return '—';
  return formatKstDateTimeLabelFromUtc(value) ?? value;
};

const formatNumber = (value: number | undefined | null) => {
  if (value === undefined || value === null) return '0';
  return value.toLocaleString('ko-KR');
};

const parseNumericValue = (value: number | string | undefined | null): number | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatCurrencyValue = (value: number | undefined | null): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }

  return formatCurrency(value);
};

// 간단한 세금 메타 파서: "2 (12% 포함)" 같은 라벨에서 세율/방식을 추출합니다.
const parseTaxMeta = (label: string | undefined | null): {
  name: string;
  rate: number | null; // 0.12 형태
  mode: 'inclusive' | 'exclusive' | 'unknown';
} => {
  if (!label) return { name: '세금', rate: null, mode: 'unknown' };
  const name = label.replace(/\(.+\)\s*$/, '').trim() || '세금';
  const percentMatch = label.match(/(\d+(?:\.\d+)?)%/);
  const rate = percentMatch ? Number(percentMatch[1]) / 100 : null;
  const inclusive = /(포함|inclusive)/i.test(label);
  const exclusive = /(별도|exclusive)/i.test(label);
  const mode: 'inclusive' | 'exclusive' | 'unknown' = inclusive ? 'inclusive' : exclusive ? 'exclusive' : 'unknown';
  return { name, rate, mode };
};

const statusBadgeClass = (status: PurchaseOrder['status']) => {
  switch (status) {
    case 'draft':
      return 'bg-sky-50 text-sky-700 ring-sky-100';
    case 'closed':
      return 'bg-emerald-50 text-emerald-700 ring-emerald-100';
    case 'partial':
      return 'bg-amber-50 text-amber-700 ring-amber-100';
    case 'canceled':
      return 'bg-rose-50 text-rose-700 ring-rose-100';
    default:
      return 'bg-slate-50 text-slate-600 ring-slate-100';
  }
};

const buildReceiptSummary = (lines: PurchaseOrder['lines']) => {
  const totalReceived = lines.reduce((sum, next) => sum + (next.receivedQty ?? 0), 0);
  const totalOrdered = lines.reduce((sum, next) => sum + next.orderedQty, 0);
  return { totalOrdered, totalReceived, remaining: Math.max(0, totalOrdered - totalReceived) };
};

type PurchaseOrderReceiptSummary = ReturnType<typeof buildReceiptSummary>;

type PurchaseOrderTimelineEntry = {
  id: string;
  title: string;
  detail: string;
  date: string;
  tone: 'current' | 'past';
};

interface MonetaryBreakdownEntry {
  key: string;
  name: string;
  rate: number | null;
  mode: 'inclusive' | 'exclusive' | 'unknown';
  base: number;
  amount: number;
}

interface MonetarySummary {
  lineTotal: number;
  baseTotal: number;
  taxTotal: number;
  total: number;
  breakdown: MonetaryBreakdownEntry[];
}

const RECEIPT_MOVEMENT_USER_ID = 'purchase-order-ui';
const PURCHASE_ORDER_DETAIL_TIMEOUT_MS = 10_000;

const pad = (value: number) => String(value).padStart(2, '0');

const formatLocalDateTimeInput = (value: Date): string => {
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1);
  const day = pad(value.getDate());
  const hours = pad(value.getHours());
  const minutes = pad(value.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

const parseLocalDateTimeIso = (value?: string): string | null => {
  if (!value) {
    return null;
  }
  const candidate = new Date(value);
  if (Number.isNaN(candidate.getTime())) {
    return null;
  }
  return candidate.toISOString();
};

const formatKstShortTimestamp = (value?: string | null): string => {
  if (!value) return '';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return '';
  }
  return new Intl.DateTimeFormat('ko-KR', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Seoul',
  }).format(timestamp);
};

const normalizePartnerName = (value?: string | null): string =>
  (value ?? '').trim().replace(/\s+/g, '').toLowerCase();

const PurchaseOrderDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [order, setOrder] = useState<PurchaseOrder | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>('items');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [receiptWarehouseCode, setReceiptWarehouseCode] = useState('');
  const [receiptDate, setReceiptDate] = useState('');
  const [receiptMemo, setReceiptMemo] = useState('');
  const [receiptMode, setReceiptMode] = useState<'bulk' | 'partial'>('bulk');
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [receiptProcessing, setReceiptProcessing] = useState(false);
  const [receiptMovements, setReceiptMovements] = useState<MovementSummary[]>([]);
  const [receiptMovementsLoading, setReceiptMovementsLoading] = useState(false);
  const [receiptMovementsError, setReceiptMovementsError] = useState<string | null>(null);
  const [partialQuantities, setPartialQuantities] = useState<Record<string, string>>({});
  const [receiptLocationCode, setReceiptLocationCode] = useState('');
  const [warehouses, setWarehouses] = useState<ApiWarehouse[]>([]);
  const [warehouseLoading, setWarehouseLoading] = useState(false);
  const [warehouseLoadError, setWarehouseLoadError] = useState<string | null>(null);
  const [locationOptions, setLocationOptions] = useState<ApiLocation[]>([]);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationLoadError, setLocationLoadError] = useState<string | null>(null);
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [receiverContactName, setReceiverContactName] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [receiverMemo, setReceiverMemo] = useState('');
  const orderMountedRef = useRef(false);
  const showToast = useToast();

  useEffect(() => {
    let mounted = true;
    void listPartners({ type: 'SUPPLIER', includeSample: true })
      .then((items) => {
        if (mounted) {
          setPartners(items);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[PurchaseOrderDetailPage] failed to load partners', err);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!receiptModalOpen) {
      return;
    }
    if (warehouses.length > 0 && !warehouseLoadError) {
      return;
    }

    let mounted = true;
    setWarehouseLoading(true);
    setWarehouseLoadError(null);
    void fetchWarehouses({ pageSize: 100 })
      .then((response) => {
        if (!mounted) {
          return;
        }
        setWarehouses(response.items ?? []);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[PurchaseOrderDetailPage] failed to load warehouses', err);
        if (!mounted) {
          return;
        }
        setWarehouseLoadError('창고 목록을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!mounted) {
          return;
        }
        setWarehouseLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [receiptModalOpen, warehouseLoadError, warehouses.length]);

  useEffect(() => {
    if (!receiptWarehouseCode) {
      setLocationOptions([]);
      setReceiptLocationCode('');
      setLocationLoadError(null);
      setLocationLoading(false);
      return;
    }

    let mounted = true;
    setLocationLoading(true);
    setLocationLoadError(null);
    void fetchLocations(receiptWarehouseCode, { pageSize: 100 })
      .then((response) => {
        if (!mounted) {
          return;
        }
        setLocationOptions(response.items ?? []);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[PurchaseOrderDetailPage] failed to load locations', err);
        if (!mounted) {
          return;
        }
        setLocationLoadError('상세 위치를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!mounted) {
          return;
        }
        setLocationLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [receiptWarehouseCode]);

  const loadOrder = useCallback(async () => {
    if (!id) {
      setError('유효한 발주번호가 필요합니다.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await getPurchaseOrder(id, {
        timeoutMs: PURCHASE_ORDER_DETAIL_TIMEOUT_MS,
      });
      if (!orderMountedRef.current) {
        return;
      }
      setOrder(data);
    } catch (err) {
      if (!orderMountedRef.current) {
        return;
      }
      setError(err instanceof Error ? err.message : '발주 정보를 불러오지 못했습니다.');
    } finally {
      if (orderMountedRef.current) {
        setLoading(false);
      }
    }
  }, [id]);

  useEffect(() => {
    orderMountedRef.current = true;
    return () => {
      orderMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void loadOrder();
  }, [loadOrder]);

  useEffect(() => {
    if (!order) {
      return;
    }
    setReceiverContactName('');
    setReceiverPhone('');
    setReceiverMemo(order.memo ?? '');
  }, [order?.id, order?.memo]);

  useEffect(() => {
    if (!order) {
      setReceiptMovements([]);
      setReceiptMovementsLoading(false);
      setReceiptMovementsError(null);
      return;
    }

    const controller = new AbortController();
    let canceled = false;

    const fetchReceiptMovements = async () => {
      setReceiptMovementsLoading(true);
      setReceiptMovementsError(null);
      setReceiptMovements([]);
      try {
        const result = await listMovements({
          refNo: order.id,
          type: 'RECEIPT',
          limit: 200,
          signal: controller.signal,
        });
        if (canceled) {
          return;
        }
        setReceiptMovements(result.items);
      } catch (err) {
        if (canceled) {
          return;
        }
        // eslint-disable-next-line no-console
        console.error('[PurchaseOrderDetailPage] failed to load receipt movements', err);
        setReceiptMovementsError('입고 내역을 불러오는 중 문제가 발생했습니다.');
      } finally {
        if (!canceled) {
          setReceiptMovementsLoading(false);
        }
      }
    };

    void fetchReceiptMovements();

    return () => {
      canceled = true;
      controller.abort();
    };
  }, [order]);

  const supplierPartner = useMemo(() => {
    if (!order) {
      return undefined;
    }
    const exactMatch = partners.find((partner) => partner.id === order.vendorId);
    if (exactMatch) {
      return exactMatch;
    }
    if (order.vendorName) {
      const targetName = normalizePartnerName(order.vendorName);
      const normalizedMatch = partners.find(
        (partner) => normalizePartnerName(partner.name) === targetName,
      );
      if (normalizedMatch) {
        return normalizedMatch;
      }
    }
    return undefined;
  }, [order, partners]);

  const partnerName = useMemo(() => {
    if (!order) return '미지정';
    return (
      order.vendorName ??
      partners.find((partner) => partner.id === order.vendorId)?.name ??
      order.vendorId
    );
  }, [order, partners]);

  const receiptSummary = useMemo(() => {
    if (!order) return null;
    return buildReceiptSummary(order.lines);
  }, [order]);

  const receipts = receiptMovements;

  // 금액(화폐) 기준 요약 계산
  const monetary = useMemo<MonetarySummary>(() => {
    if (!order) {
      return {
        lineTotal: 0,
        baseTotal: 0,
        taxTotal: 0,
        total: 0,
        breakdown: [],
      };
    }

    const round = (n: number) => Math.round(Number.isFinite(n) ? n : 0);

    type Acc = {
      lineTotal: number;
      baseTotal: number;
      taxTotal: number;
      total: number;
      map: Map<string, MonetaryBreakdownEntry>;
    };

    const acc: Acc = {
      lineTotal: 0,
      baseTotal: 0,
      taxTotal: 0,
      total: 0,
      map: new Map(),
    };

    for (const line of order.lines) {
      const unitPrice = parseNumericValue(line.unitPrice) ?? 0;
      const grossFromLine = parseNumericValue(line.amount);
      const gross = grossFromLine !== null ? round(grossFromLine) : round(unitPrice * line.orderedQty);
      const meta = parseTaxMeta(line.taxLabel);
      const explicitTax = parseNumericValue(line.taxAmount);

      let base = gross;
      let tax = 0;
      if (explicitTax !== null) {
        tax = round(explicitTax);
        base = round(Math.max(0, gross - tax));
      } else if (meta.rate !== null) {
        if (meta.mode === 'inclusive') {
          const computedBase = round(gross / (1 + meta.rate));
          base = computedBase;
          tax = round(Math.max(0, gross - computedBase));
        } else if (meta.mode === 'exclusive') {
          base = round(gross);
          tax = round(gross * meta.rate);
        }
      }

      const total = base + tax;

      acc.lineTotal += gross;
      acc.baseTotal += base;
      acc.taxTotal += tax;
      acc.total += total;

      const key = line.taxLabel || meta.name;
      const existing = acc.map.get(key);
      if (existing) {
        existing.base += base;
        existing.amount += tax;
      } else {
        acc.map.set(key, { key, name: meta.name, rate: meta.rate, mode: meta.mode, base, amount: tax });
      }
    }

    return {
      lineTotal: acc.lineTotal,
      baseTotal: acc.baseTotal,
      taxTotal: acc.taxTotal,
      total: acc.total,
      breakdown: Array.from(acc.map.values()),
    };
  }, [order]);

  const timeline = useMemo<PurchaseOrderTimelineEntry[]>(() => {
    if (!order) return [];
    const summary = receiptSummary ?? { totalOrdered: 0, totalReceived: 0, remaining: 0 };
    const entries: PurchaseOrderTimelineEntry[] = [];
    entries.push({
      id: 'creation',
      title: '발주 생성',
      detail: '사용자 배포자',
      date: order.createdAt,
      tone: summary.totalReceived === 0 ? 'current' : 'past',
    });
    if (order.approvedAt) {
      entries.push({
        id: 'approved',
        title: '발주 확정',
        detail: '시스템',
        date: order.approvedAt,
        tone: summary.totalReceived === 0 ? 'past' : 'past',
      });
    }
    if (summary.totalReceived > 0) {
      entries.push({
        id: 'received',
        title: '입고 완료',
        detail: `${formatNumber(summary.totalReceived)} EA 입고`,
        date: order.approvedAt ?? order.promisedDate ?? order.createdAt,
        tone: 'current',
      });
    }
    return entries;
  }, [order, receiptSummary]);

  const handlePrint = useCallback(() => {
    setPrintModalOpen(true);
  }, []);

  const handleClosePrintModal = useCallback(() => {
    setPrintModalOpen(false);
  }, []);

  const handleConfirmPrint = useCallback(() => {
    setPrintModalOpen(false);
    setTimeout(() => {
      if (typeof window === 'undefined') {
        return;
      }
      window.print();
    }, 0);
  }, []);

  const handleExport = useCallback(() => {
    if (!order) return;
    const header = ['SKU', '요청 수량', '입고 수량', '단위', '상태'];
    const rows = order.lines.map((line) => [
      line.sku,
      line.orderedQty.toString(),
      (line.receivedQty ?? 0).toString(),
      line.status,
      line.unit,
    ]);
    const csv = [header, ...rows].map((row) => row.map((value) => `"${value?.replace(/"/g, '""') ?? ''}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const downloadIdentifier = order.orderNumber ?? order.id;
    link.download = `${downloadIdentifier}-lines.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [order]);

  const closeReceiptModal = useCallback(() => {
    setReceiptModalOpen(false);
    setReceiptWarehouseCode('');
    setReceiptLocationCode('');
    setLocationOptions([]);
    setLocationLoadError(null);
    setLocationLoading(false);
    setReceiptDate('');
    setReceiptMemo('');
    setReceiptMode('bulk');
    setReceiptError(null);
    setPartialQuantities({});
  }, []);

  const parsePartialQuantity = useCallback(
    (lineId: string, max: number) => {
      const raw = partialQuantities[lineId];
      if (!raw) {
        return 0;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        return 0;
      }
      return Math.min(Math.max(0, Math.round(parsed)), max);
    },
    [partialQuantities],
  );

  const openReceiptModal = useCallback(
    (mode: 'bulk' | 'partial') => {
      setReceiptMode(mode);
      if (mode === 'partial' && order) {
        const defaults: Record<string, string> = {};
        order.lines.forEach((line) => {
          const remaining = Math.max(0, line.orderedQty - (line.receivedQty ?? 0));
          if (remaining > 0) {
            defaults[line.id] = String(remaining);
          }
        });
        setPartialQuantities(defaults);
      }
      setReceiptModalOpen(true);
      setReceiptDate(formatLocalDateTimeInput(new Date()));
      setReceiptError(null);
    },
    [order],
  );

  const handleBulkReceive = useCallback(() => {
    openReceiptModal('bulk');
  }, [openReceiptModal]);

  const handlePartialReceive = useCallback(() => {
    openReceiptModal('partial');
  }, [openReceiptModal]);

  const handleReceiptSubmit = useCallback(async () => {
    if (!order) {
      return;
    }
    const warehouseValue = receiptWarehouseCode.trim();
    if (!warehouseValue) {
      setReceiptError('입고 창고를 선택해 주세요.');
      return;
    }
    const parsedIso = parseLocalDateTimeIso(receiptDate);
    const occurredDate = parsedIso ? new Date(parsedIso) : new Date();
    const now = Date.now();
    if (occurredDate.getTime() > now) {
      setReceiptError('입고일은 현재 시각을 초과할 수 없습니다.');
      return;
    }
    const occurredAt = occurredDate.toISOString();
    const memo = receiptMemo.trim() || undefined;
    const createPayload = (line: PurchaseOrder['lines'][number], quantity: number): CreateMovementPayload => ({
      type: 'RECEIPT',
      sku: line.sku,
      qty: quantity,
      toWarehouse: warehouseValue,
      toLocation: receiptLocationCode ? receiptLocationCode : undefined,
      partnerId: order.vendorId,
      refNo: order.id,
      memo,
      occurredAt,
      userId: RECEIPT_MOVEMENT_USER_ID,
      poId: order.id,
      poLineId: line.id,
    });

    const payloads: CreateMovementPayload[] = [];

    order.lines.forEach((line) => {
      const remaining = Math.max(0, line.orderedQty - (line.receivedQty ?? 0));
      if (remaining <= 0) {
        return;
      }
      if (receiptMode === 'bulk') {
        payloads.push(createPayload(line, remaining));
        return;
      }
      const quantity = parsePartialQuantity(line.id, remaining);
      if (quantity > 0) {
        payloads.push(createPayload(line, quantity));
      }
    });

    if (payloads.length === 0) {
      setReceiptError('입고할 품목과 수량을 선택해 주세요.');
      return;
    }

    setReceiptProcessing(true);
    setReceiptError(null);
    try {
      await Promise.all(payloads.map((payload) => submitMovement(payload)));
      showToast(
        receiptMode === 'bulk' ? '일괄 입고가 기록되었습니다.' : '부분 입고가 기록되었습니다.',
        { tone: 'success' },
      );
      closeReceiptModal();
      await loadOrder();
    } catch (error) {
      const message = error instanceof Error ? error.message : '입고 처리에 실패했습니다.';
      setReceiptError(message);
      showToast(message, { tone: 'error' });
    } finally {
      setReceiptProcessing(false);
    }
  }, [
    closeReceiptModal,
    loadOrder,
    order,
    parsePartialQuantity,
    receiptWarehouseCode,
    receiptLocationCode,
    receiptMemo,
    receiptMode,
    receiptDate,
    showToast,
  ]);

  const hasPartialEntries = useMemo(() => {
    if (!order) {
      return false;
    }
    return order.lines.some((line) => {
      const remaining = Math.max(0, line.orderedQty - (line.receivedQty ?? 0));
      if (remaining <= 0) {
        return false;
      }
      return parsePartialQuantity(line.id, remaining) > 0;
    });
  }, [order, parsePartialQuantity]);

  const warehouseSelectDisabled = warehouseLoading || (!warehouseLoadError && warehouses.length === 0);
  const warehouseSelectPlaceholder = warehouseLoading
    ? '창고 목록을 불러오는 중입니다...'
    : warehouseLoadError
    ? '창고 목록을 불러오지 못했습니다.'
    : warehouses.length === 0
    ? '등록된 창고가 없습니다.'
    : '창고를 선택하세요';
  const isReceiptSubmitDisabled =
    receiptProcessing || !receiptWarehouseCode.trim() || (receiptMode === 'partial' && !hasPartialEntries);
  const locationSelectDisabled = locationLoading || !receiptWarehouseCode;
  const locationSelectPlaceholder = locationLoading
    ? '상세 위치를 불러오는 중입니다...'
    : locationLoadError
    ? '상세 위치를 불러오지 못했습니다.'
    : !receiptWarehouseCode
    ? '창고를 먼저 선택하세요'
    : locationOptions.length === 0
    ? '등록된 상세 위치가 없습니다.'
    : '상세 위치를 선택하세요';
  const isPrintDisabled = loading || !order;
  const isExportDisabled = !order;

  if (loading && !order && !error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-slate-500">발주 정보를 불러오는 중입니다…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="space-y-3 text-center">
          <p className="text-sm font-semibold text-rose-600">{error}</p>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            홈으로 이동
          </button>
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-slate-500">해당 발주서를 찾을 수 없습니다.</p>
      </div>
    );
  }

  const totalLines = order.lines.length;

  return (
    <>
      <div className="min-h-screen bg-slate-50 px-8 py-8 text-slate-900 print:hidden">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-400">구매 및 발주 · 발주 내역</div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {(order.orderNumber ?? order.id).toUpperCase()}
            </h1>
            <span className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${statusBadgeClass(order.status as PurchaseOrder['status'])}`}>
              {getPurchaseStatusLabel(order.status)}
            </span>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
              {totalLines}개 품목 · 총 수량 {formatNumber(receiptSummary?.totalOrdered ?? 0)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <div>
              주문일 <span className="font-medium text-slate-700">{formatDateLabel(order.createdAt)}</span>
            </div>
            <div className="h-3 w-px bg-slate-200" />
            <div>
              입고 예정일 <span className="font-medium text-slate-700">{formatDateLabel(order.promisedDate)}</span>
            </div>
            <div className="h-3 w-px bg-slate-200" />
            <div>
              공급자 <span className="font-medium text-slate-700">{partnerName}</span>
            </div>
            <div className="h-3 w-px bg-slate-200" />
            <div>
              메모 <span className="font-normal text-slate-400">{order.memo || '내부 메모 없음'}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleBulkReceive}
            className="rounded-full bg-indigo-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-indigo-700"
          >
            일괄입고
          </button>
          <button
            type="button"
            onClick={handlePartialReceive}
            className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            부분입고
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,2.3fr)_minmax(0,1fr)] gap-6">
        <div className="space-y-6">
          <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">발주 기본 정보</h2>
              <span className="text-xs text-slate-400">자동 저장 완료</span>
            </div>
            <div className="grid grid-cols-3 gap-y-3 text-xs text-slate-500">
              <div className="space-y-1">
                <div className="text-[11px]">발주 코드</div>
                <div className="font-medium text-slate-800">{order.orderNumber ?? order.id}</div>
              </div>
              <div className="space-y-1">
                <div className="text-[11px]">공급자</div>
                <div className="font-medium text-slate-800">{partnerName}</div>
              </div>
              <div className="space-y-1">
                <div className="text-[11px]">발주 상태</div>
                <div className="font-medium text-slate-900">{getPurchaseStatusLabel(order.status)}</div>
              </div>
              <div className="space-y-1">
                <div className="text-[11px]">주문일</div>
                <div className="text-slate-800">{formatDateLabel(order.createdAt)}</div>
              </div>
              <div className="space-y-1">
                <div className="text-[11px]">입고 예정일</div>
                <div className="text-slate-800">{formatDateLabel(order.promisedDate)}</div>
              </div>
              <div className="space-y-1">
                <div className="text-[11px]">결제 상태</div>
                <div className="text-slate-800">미지급 (외상)</div>
              </div>
            </div>
          </section>

          <section className="rounded-2xl bg-white pt-2 shadow-sm ring-1 ring-slate-100">
            <div className="flex items-center justify-between px-4 pb-1">
              <div className="flex gap-2 rounded-full bg-slate-100 p-1 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setActiveTab('items')}
                  className={`rounded-full px-3 py-1 transition ${
                    activeTab === 'items'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-500'
                  }`}
                >
                  발주 품목
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('receipts')}
                  className={`rounded-full px-3 py-1 transition ${
                    activeTab === 'receipts'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-500'
                  }`}
                >
                  입고 내역
                </button>
              </div>
              <div className="text-[11px] text-slate-400">
                {activeTab === 'items'
                  ? `${totalLines}개 품목 / 총 ${formatNumber(receiptSummary?.totalOrdered ?? 0)}개`
                  : `${receipts.length}건 입고 완료`}
              </div>
            </div>

        {activeTab === 'items' ? (
          <div className="border-t border-slate-100">
            <table className="min-w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-[11px] text-slate-500">
                  <th className="px-4 py-2 font-medium">제품</th>
                  <th className="px-2 py-2 text-right font-medium">수량</th>
                  <th className="px-2 py-2 text-right font-medium">단가</th>
                  <th className="px-2 py-2 text-right font-medium">세금</th>
                  <th className="px-4 py-2 text-right font-medium">금액</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line) => {
                  const unitLabel = line.unit?.trim() || 'EA';
                      const productNameLabel = line.productName?.trim();
                      const productTitle = productNameLabel ? `${productNameLabel} (${line.sku})` : line.sku;
                      const subtitleParts = [unitLabel];
                  const formattedUnitPrice = parseNumericValue(line.unitPrice);
                  const taxAmount = parseNumericValue(line.taxAmount);
                  const amountValue =
                    parseNumericValue(line.amount) ??
                    (formattedUnitPrice !== null ? formattedUnitPrice * line.orderedQty : null);
                  const taxLabelText = line.taxLabel?.trim();
                  const taxMeta = parseTaxMeta(taxLabelText);
                  // 세금 금액: 명시 값 우선, 없으면 라벨 기반 계산
                  let computedTax: number | null = taxAmount;
                  if (computedTax === null && amountValue !== null && taxMeta.rate !== null) {
                    if (taxMeta.mode === 'inclusive') {
                      const base = Math.round(amountValue / (1 + taxMeta.rate));
                      computedTax = Math.max(0, Math.round(amountValue - base));
                    } else if (taxMeta.mode === 'exclusive') {
                      computedTax = Math.round(amountValue * taxMeta.rate);
                    }
                  }

                  return (
                    <tr
                      key={line.id}
                      className="border-b border-slate-50 hover:bg-slate-50/60"
                    >
                      <td className="px-4 py-3 align-top">
                        <div className="text-xs font-medium text-slate-900">{productTitle}</div>
                        {subtitleParts.length > 0 && (
                          <div className="text-[11px] text-slate-400">
                            {subtitleParts.join(' · ')}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-3 text-right text-xs text-slate-700">
                        {formatNumber(line.orderedQty)} {unitLabel}
                      </td>
                      <td className="px-2 py-3 text-right text-xs text-slate-700">
                        {formatCurrencyValue(formattedUnitPrice)}
                      </td>
                      <td className="px-2 py-3 text-right text-xs text-slate-700">
                        <div>{formatCurrencyValue(computedTax)}</div>
                        {taxLabelText && (
                          <div className="text-[11px] text-slate-400">{taxLabelText}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-xs font-semibold text-slate-900">
                        {formatCurrencyValue(amountValue)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-[11px] text-slate-400">
              <div>발주 메모</div>
              <button
                type="button"
                className="rounded-full border border-dashed border-slate-300 px-3 py-1 text-[11px] text-slate-500 hover:border-slate-400 hover:text-slate-700"
              >
                메모 추가
              </button>
            </div>

            <div className="mt-5 rounded-2xl border border-slate-100 bg-slate-50 p-5 text-sm text-slate-600">
              <dl className="space-y-3">
                <div className="flex items-center justify-between">
                  <dt>소계</dt>
                  <dd className="font-medium text-slate-900">{formatCurrency(monetary.lineTotal)}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt>총액 (세금 제외)</dt>
                  <dd className="font-medium text-slate-900">{formatCurrency(monetary.baseTotal)}</dd>
                </div>
                {monetary.breakdown.map((entry) => (
                  <div key={entry.key} className="flex items-center justify-between">
                    <dt className="text-xs text-slate-500">
                      {entry.name}
                      {entry.rate !== null && (
                        <>
                          {' '}
                          ({formatCurrency(entry.base)}에 대한 {(entry.rate * 100).toFixed(0)}%
                          {entry.mode === 'inclusive' ? ' 포함' : ''})
                        </>
                      )}
                    </dt>
                    <dd className="font-medium text-slate-900">{formatCurrency(entry.amount)}</dd>
                  </div>
                ))}
                <div className="flex items-center justify-between text-sm">
                  <dt className="font-semibold text-slate-900">총액</dt>
                  <dd className="text-base font-semibold text-slate-900">{formatCurrency(monetary.total)}</dd>
                </div>
              </dl>
            </div>
          </div>
        ) : (
          <div className="border-t border-slate-100">
            <table className="min-w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-[11px] text-slate-500">
                      <th className="px-4 py-2 font-medium">날짜</th>
                      <th className="px-4 py-2 font-medium">입고 수량</th>
                      <th className="px-4 py-2 font-medium">상세</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receiptMovementsLoading ? (
                      <tr>
                        <td colSpan={3} className="px-4 py-6 text-center text-[11px] text-slate-400">
                          입고 기록을 불러오는 중입니다…
                        </td>
                      </tr>
                    ) : receiptMovementsError ? (
                      <tr>
                        <td colSpan={3} className="px-4 py-6 text-center text-[11px] text-rose-500">
                          {receiptMovementsError}
                        </td>
                      </tr>
                    ) : receipts.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="px-4 py-6 text-center text-[11px] text-slate-400">
                          입고 기록이 없습니다.
                        </td>
                      </tr>
                    ) : (
                      receipts.map((receipt) => (
                        <tr
                          key={receipt.id}
                          className="border-b border-slate-50 hover:bg-slate-50/60"
                        >
                          <td className="px-4 py-3 text-xs text-slate-700">
                            {formatDateLabel(receipt.occurredAt)}
                          </td>
                          <td className="px-4 py-3 text-xs font-semibold text-slate-900">
                            {formatNumber(receipt.qty)} EA
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-500">{receipt.sku}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-4">
          <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
            <h3 className="mb-3 text-sm font-semibold text-slate-900">발주서 공유</h3>
            <div className="space-y-2 text-xs">
              <button
                type="button"
                onClick={handlePrint}
                disabled={isPrintDisabled}
                className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
              >
                <span>발주서 인쇄</span>
                <span className="text-[11px] text-slate-400">PDF / 프린터</span>
              </button>
              <button
                type="button"
                onClick={handleExport}
                disabled={isExportDisabled}
                className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
              >
                <span>엑셀로 내보내기</span>
                <span className="text-[11px] text-slate-400">라인 상세 포함</span>
              </button>
            </div>
          </section>

        </aside>
      </div>
      <div className="print:hidden">
        <Modal
          isOpen={receiptModalOpen}
          onClose={closeReceiptModal}
          title={receiptMode === 'partial' ? '부분 입고' : '일괄 입고'}
          widthClassName="max-w-md"
        >
          <div className="space-y-4 text-sm text-slate-700">
            {receiptError && (
              <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-600">{receiptError}</div>
            )}
            {receiptMode === 'partial' && order && (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-slate-600">품목별 입고 수량</div>
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {order.lines.map((line) => {
                    const remaining = Math.max(0, line.orderedQty - (line.receivedQty ?? 0));
                    if (remaining <= 0) {
                      return null;
                    }
                    const value = partialQuantities[line.id] ?? String(remaining);
                    return (
                      <div
                        key={line.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"
                      >
                        <div>
                          <div className="text-xs font-semibold text-slate-900">{line.sku}</div>
                          <div className="text-[11px] text-slate-400">남은 수량 {formatNumber(remaining)} EA</div>
                        </div>
                        <input
                          type="number"
                          min={0}
                          max={remaining}
                          value={value}
                          onChange={(event) => {
                            const next = event.target.value;
                            setPartialQuantities((prev) => ({ ...prev, [line.id]: next }));
                          }}
                          className="w-28 rounded-md border border-slate-200 bg-white px-2 py-1 text-right text-xs text-slate-900 focus:border-indigo-500 focus:outline-none"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div>
              <label className="mb-1 flex items-center text-xs font-semibold text-slate-600">
                위치<span className="ml-1 text-rose-500">*</span>
              </label>
              <select
                value={receiptWarehouseCode}
                onChange={(event) => {
                  const next = event.target.value;
                  setReceiptWarehouseCode(next);
                  setReceiptLocationCode('');
                }}
                disabled={warehouseSelectDisabled}
                className={`w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none ${
                  warehouseSelectDisabled ? 'cursor-not-allowed bg-slate-50 text-slate-400' : ''
                }`}
              >
                <option value="" disabled>
                  {warehouseSelectPlaceholder}
                </option>
                {warehouses.map((warehouse) => (
                  <option key={warehouse.code} value={warehouse.code}>
                    {warehouse.name ? `${warehouse.name} (${warehouse.code})` : warehouse.code}
                  </option>
                ))}
              </select>
              {warehouseLoadError ? (
                <p className="mt-1 text-xs text-rose-500">{warehouseLoadError}</p>
              ) : null}
            </div>
            <div>
              <label className="mb-1 flex items-center text-xs font-semibold text-slate-600">
                상세 위치<span className="ml-1 text-xs font-normal text-slate-500">(선택)</span>
              </label>
              <select
                value={receiptLocationCode}
                onChange={(event) => setReceiptLocationCode(event.target.value)}
                disabled={locationSelectDisabled}
                className={`w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none ${
                  locationSelectDisabled ? 'cursor-not-allowed bg-slate-50 text-slate-400' : ''
                }`}
              >
                <option value="" disabled>
                  {locationSelectPlaceholder}
                </option>
                {locationOptions.map((location) => (
                  <option key={location.code} value={location.code}>
                    {location.description ?? location.code}
                  </option>
                ))}
              </select>
              {locationLoadError ? (
                <p className="mt-1 text-xs text-rose-500">{locationLoadError}</p>
              ) : null}
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">날짜</label>
              <input
                type="datetime-local"
                value={receiptDate}
                max={formatLocalDateTimeInput(new Date())}
                step={60}
                onChange={(event) => setReceiptDate(event.target.value)}
                className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">메모</label>
              <textarea
                rows={4}
                value={receiptMemo}
                onChange={(event) => setReceiptMemo(event.target.value)}
                placeholder="입고서에 필요한 메모를 자유롭게 작성해 주세요."
                className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={closeReceiptModal}
                className="rounded-full border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
              >
                취소
              </button>
              <button
                type="button"
                onClick={handleReceiptSubmit}
                disabled={isReceiptSubmitDisabled}
                className="flex items-center justify-center rounded-full bg-indigo-600 px-4 py-2 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
              >
                {receiptProcessing ? '입고 처리 중…' : '입고 처리'}
              </button>
            </div>
          </div>
        </Modal>
      </div>
      <div className="print:hidden">
        <Modal
          isOpen={printModalOpen}
          onClose={handleClosePrintModal}
          title="발주서 인쇄 정보"
          widthClassName="max-w-md"
        >
          <div className="space-y-4 text-sm text-slate-700">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">공급받는자 담당자</label>
              <input
                type="text"
                value={receiverContactName}
                onChange={(event) => setReceiverContactName(event.target.value)}
                className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">공급받는자 연락처</label>
              <input
                type="text"
                value={receiverPhone}
                onChange={(event) => setReceiverPhone(event.target.value)}
                className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">메모</label>
              <textarea
                rows={3}
                value={receiverMemo}
                onChange={(event) => setReceiverMemo(event.target.value)}
                placeholder="공급받는자 정보를 간단히 입력해 주세요."
                className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={handleClosePrintModal}
                className="rounded-full border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
              >
                취소
              </button>
              <button
                type="button"
                onClick={handleConfirmPrint}
                className="flex items-center justify-center rounded-full bg-indigo-600 px-4 py-2 text-xs font-medium text-white transition hover:bg-indigo-700"
              >
                인쇄
              </button>
            </div>
          </div>
        </Modal>
      </div>
    </div>
    <PurchaseOrderPrintDocument
      order={order}
      partner={supplierPartner}
      partnerName={partnerName}
      timeline={timeline}
      receiptSummary={receiptSummary}
      monetary={monetary}
      receiverContactName={receiverContactName}
      receiverPhone={receiverPhone}
      receiverMemo={receiverMemo}
    />
    </>
  );
};

interface PurchaseOrderPrintDocumentProps {
  order: PurchaseOrder;
  partner?: Partner;
  partnerName: string;
  timeline: PurchaseOrderTimelineEntry[];
  receiptSummary: PurchaseOrderReceiptSummary | null;
  monetary: MonetarySummary;
  receiverContactName: string;
  receiverPhone: string;
  receiverMemo: string;
}

const PurchaseOrderPrintDocument: React.FC<PurchaseOrderPrintDocumentProps> = ({
  order,
  partner,
  partnerName,
  timeline,
  receiptSummary,
  monetary,
  receiverContactName,
  receiverPhone,
  receiverMemo,
}) => {
  const printTimestamp = formatKstShortTimestamp(order.createdAt);
  const createdLabel = formatDateLabel(order.createdAt);
  const promisedLabel = formatDateLabel(order.promisedDate);
  const createdKstLabel = formatKstDateTimeLabelFromUtc(order.createdAt) ?? createdLabel;
  const promisedKstCandidate = order.promisedDate
    ? formatKstDateTimeLabelFromUtc(order.promisedDate)
    : null;
  const promisedKstLabel = promisedKstCandidate ?? promisedLabel;
  const statusLabel = getPurchaseStatusLabel(order.status);
  const totalOrdered =
    receiptSummary?.totalOrdered ?? order.lines.reduce((sum, line) => sum + line.orderedQty, 0);
  const totalReceived =
    receiptSummary?.totalReceived ?? order.lines.reduce((sum, line) => sum + (line.receivedQty ?? 0), 0);
  const remainingQty =
    receiptSummary?.remaining ?? Math.max(0, totalOrdered - totalReceived);
  const timelineEntries =
    timeline.length > 0
      ? timeline
      : [
          {
            id: 'print-empty',
            title: '상태 정보 없음',
            detail: '기록이 없습니다.',
            date: order.createdAt,
            tone: 'past' as const,
          },
        ];
  const breakdownEntries =
    monetary.breakdown.length > 0
      ? monetary.breakdown
      : monetary.taxTotal > 0
      ? [
          {
            key: 'print-default-tax',
            name: '부가세',
            rate: null,
            mode: 'unknown',
            base: monetary.baseTotal,
            amount: monetary.taxTotal,
          },
        ]
      : [];
  const memoText = order.memo?.trim() || '메모 없음';
  const supplierLabel = partner?.name ?? partnerName;
  const supplierPhone = partner?.phone ?? '—';
  const supplierEmail = partner?.email ?? '—';
  const supplierAddress = partner?.address ?? '—';
  const orderNumber = order.orderNumber ?? order.id;
  const receiverContactLabel = receiverContactName.trim() || '—';
  const receiverPhoneLabel = receiverPhone.trim() || '—';
  const receiverMemoLabel = receiverMemo.trim() || '메모 없음';

  return (
    <div className="print-document">
      <div className="min-h-screen w-full bg-slate-200 flex items-start justify-center py-8 print:bg-white print:py-0 print:min-h-0">
        <main className="relative bg-white w-[794px] min-h-[1123px] px-10 py-8 pb-12 text-slate-900 text-[10px] leading-relaxed rounded-[32px] border border-slate-200 shadow-[0_20px_60px_rgba(15,23,42,0.12)] print:border-0 print:shadow-none print:w-[176mm] print:max-w-[176mm] print:min-h-0 print:h-auto print:px-6 print:py-6 print:pb-6 print:rounded-[24px] print:bg-white print:overflow-visible">
          <header className="flex items-start justify-between border-b border-slate-200 pb-3 mb-3 print-avoid-break">
            <div>
              <div className="flex flex-wrap items-end gap-3">
                <h1 className="text-xl font-semibold text-slate-900">구매 발주서</h1>
                <span className="text-base font-medium text-slate-500">(Purchase Order)</span>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[10px] font-medium tracking-[0.3em] text-slate-500 uppercase">발주번호</p>
              <p className="text-xl font-semibold text-slate-900">{orderNumber}</p>
              <span
                className={`mt-2 inline-flex items-center justify-center rounded-full border px-2 py-[2px] text-[9px] font-semibold ring-1 ring-inset ${statusBadgeClass(
                  order.status,
                )}`}
              >
                {statusLabel}
              </span>
            </div>
          </header>

          <section className="grid grid-cols-2 gap-3 mb-4 text-[10px] print-avoid-break">
            <div className="space-y-1">
              <p>
                <span className="font-medium text-slate-500">작성일:</span>{' '}
                <span className="font-semibold text-slate-900">{createdKstLabel}</span>
              </p>
              <p>
                <span className="font-medium text-slate-500">입고 예정일:</span>{' '}
                <span className="font-semibold text-slate-900">{promisedKstLabel}</span>
              </p>
            </div>
            <div className="space-y-1 text-right">
              <p>
                <span className="font-medium text-slate-500">발주 상태:</span>{' '}
                <span className="font-semibold text-slate-900">{statusLabel}</span> · 총 수량{' '}
                <span className="font-semibold text-slate-900">{formatNumber(totalOrdered)}</span> EA
              </p>
            </div>
          </section>

          <section className="grid gap-3 lg:grid-cols-2 mb-4 print-avoid-break">
            <article className="rounded-xl border border-slate-200 bg-white p-3">
              <h2 className="mb-2 text-xs font-semibold text-slate-900">공급자 정보</h2>
              <dl className="space-y-2 text-[10px] text-slate-500">
                <div className="flex justify-between">
                  <dt className="text-slate-400">공급자</dt>
                  <dd className="font-semibold text-slate-900">{supplierLabel}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">연락처</dt>
                  <dd className="font-semibold text-slate-900">{supplierPhone}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">이메일</dt>
                  <dd className="font-semibold text-slate-900">{supplierEmail}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">주소</dt>
                  <dd className="font-semibold text-slate-900">{supplierAddress}</dd>
                </div>
              </dl>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-3">
              <h2 className="mb-2 text-xs font-semibold text-slate-900">공급받는 자</h2>
              <dl className="space-y-2 text-[10px] text-slate-500">
                <div className="flex justify-between">
                  <dt className="text-slate-400">담당자</dt>
                  <dd className="font-semibold text-slate-900">{receiverContactLabel}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">연락처</dt>
                  <dd className="font-semibold text-slate-900">{receiverPhoneLabel}</dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-slate-400">메모</dt>
                  <dd className="font-semibold text-slate-900 text-[10px] whitespace-pre-line">
                    {receiverMemoLabel}
                  </dd>
                </div>
              </dl>
            </article>
          </section>

          <section className="mb-4 print-avoid-break">
            <div className="mb-2 flex items-center justify-between text-[11px]">
              <h2 className="text-xs font-semibold text-slate-900">품목 내역</h2>
              <p className="text-[9px] text-slate-500">총 {order.lines.length}건</p>
            </div>
            <div className="overflow-hidden rounded-2xl border border-slate-100">
              <table className="min-w-full border-collapse text-left text-[10px]">
                <thead className="bg-slate-50 text-slate-500 text-[9px] uppercase tracking-wider">
                  <tr>
                    <th className="px-2 py-2 font-semibold text-left text-[9px]">제품명 / 코드</th>
                    <th className="px-2 py-2 font-semibold text-left text-[9px]">규격</th>
                    <th className="px-2 py-2 font-semibold text-right text-[9px]">수량</th>
                    <th className="px-2 py-2 font-semibold text-right text-[9px]">단가</th>
                    <th className="px-2 py-2 font-semibold text-right text-[9px]">세액</th>
                    <th className="px-2 py-2 font-semibold text-right text-[9px]">금액</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-2 py-5 text-center text-[10px] text-slate-400">
                        등록된 품목이 없습니다.
                      </td>
                    </tr>
                  ) : (
                    order.lines.map((line) => {
                      const quantity = line.orderedQty;
                      const rawUnitPrice = parseNumericValue(line.unitPrice) ?? 0;
                      const numerator = parseNumericValue(line.amount) ?? 0;
                      const computedUnitPrice =
                        rawUnitPrice > 0
                          ? rawUnitPrice
                          : quantity > 0
                          ? Math.round(numerator / Math.max(1, quantity))
                          : 0;
                      const taxValue = parseNumericValue(line.taxAmount) ?? 0;
                      const amountValue =
                        parseNumericValue(line.amount) ??
                        Math.round(computedUnitPrice * Math.max(0, quantity));
                      return (
                        <tr key={line.id} className="border-b border-slate-100">
                          <td className="px-2 py-2">
                            <div className="font-semibold text-slate-900 text-[10px]">
                              {line.productName ?? line.sku}
                            </div>
                            <div className="text-[9px] uppercase tracking-wide text-slate-400">
                              {line.sku}
                            </div>
                          </td>
                          <td className="px-2 py-2 text-[10px] font-semibold text-slate-900">
                            {line.unit ?? 'EA'}
                          </td>
                          <td className="px-2 py-2 text-right font-semibold text-slate-900 text-[10px]">
                            {formatNumber(quantity)}
                          </td>
                          <td className="px-2 py-2 text-right text-[10px] text-slate-900">
                            {formatCurrency(computedUnitPrice)}
                          </td>
                          <td className="px-2 py-2 text-right text-[10px] text-slate-900">
                            {formatCurrency(taxValue)}
                          </td>
                          <td className="px-2 py-2 text-right font-semibold text-slate-900 text-[10px]">
                            {formatCurrency(amountValue)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

        </main>
      </div>
    </div>
  );
};

export default PurchaseOrderDetailPage;
