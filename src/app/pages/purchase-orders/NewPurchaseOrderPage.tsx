import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Partner } from '../../../services/orders';
import { listPartners } from '../../../services/orders';
import type { Product } from '../../../services/products';
import { fetchProducts } from '../../../services/products';
import {
  createPurchaseOrder,
  createPurchaseOrderDraft,
  getNextPurchaseOrderNumber,
  updatePurchaseOrderDraft,
  type CreatePurchaseOrderLine,
  type PurchaseOrder,
} from '../../../services/purchaseOrders';
import { submitMovement, type CreateMovementPayload } from '../../../services/movements';
import { useToast } from '@/src/components/Toaster';
import Modal from '@/components/ui/Modal';
import { fetchWarehouses, fetchLocations, type ApiLocation, type ApiWarehouse } from '../../../services/api';
import { createTaxType, listTaxTypes, type TaxMode, type TaxType } from '../../../services/taxTypes';

type DraftLine = {
  id: string;
  productSku: string;
  productName: string;
  quantity: string;
  unitPrice: string;
  taxTypeId: string | null;
};

const createLineId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);

const createEmptyLine = (): DraftLine => ({
  id: createLineId(),
  productSku: '',
  productName: '',
  quantity: '',
  unitPrice: '',
  taxTypeId: null,
});

const formatCurrency = (value: number) =>
  Number.isFinite(value)
    ? value.toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : '0';
const formatPriceInput = (value: number | null | undefined) =>
  value !== null && value !== undefined ? value.toFixed(2) : '';

const normalizePurchasePriceEntry = (value: string) => {
  const stripped = value.replace(/[^\d.]/g, '');
  if (stripped === '') {
    return '';
  }
  const parts = stripped.split('.');
  const integerPart = parts[0];
  const fractional = parts[1] ? parts[1].slice(0, 2) : '';
  return fractional ? `${integerPart}.${fractional}` : integerPart;
};

const formatPurchasePriceForDisplay = (raw: string) => {
  if (!raw) {
    return '';
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return '';
  }
  const decimalPart = raw.includes('.') ? raw.split('.')[1] : '';
  const hasNonZeroDecimal = /[1-9]/.test(decimalPart);
  const decimals = hasNonZeroDecimal ? Math.min(2, decimalPart.length) : 0;
  return numeric.toLocaleString('ko-KR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

const toIsoStartOfDay = (value?: string): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = new Date(`${trimmed}T00:00:00+09:00`);
  if (Number.isNaN(candidate.getTime())) {
    return null;
  }
  return candidate.toISOString();
};

const RECEIPT_MOVEMENT_USER_ID = 'purchase-order-ui';

const DRAFT_STORAGE_KEY = 'purchase-order:draft';

const TAX_ADD_KEY = '__tax_add__';

type LineSummary = {
  lineId: string;
  base: number;
  tax: number;
  total: number;
  taxType: TaxType | null;
};

type TaxBreakdownEntry = {
  taxType: TaxType;
  base: number;
  amount: number;
};

const roundToWon = (value: number) => Math.round(value);

interface PurchaseOrderDraft {
  supplier: string;
  orderNumber: string;
  orderDate: string;
  expectedDate: string;
  memo: string;
  receivingMode: string;
  receivingNote: string;
  warehouse: string;
  location: string;
  lines: DraftLine[];
  draftId?: string;
}

const NewPurchaseOrderPage: React.FC = () => {
  const navigate = useNavigate();
  const [supplier, setSupplier] = useState('');
  const [orderDate, setOrderDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [expectedDate, setExpectedDate] = useState('');
  const [memo, setMemo] = useState('');
  const [receivingMode, setReceivingMode] = useState('즉시입고');
  const [receivingNote, setReceivingNote] = useState('');
  const [warehouse, setWarehouse] = useState('');
  const [location, setLocation] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([createEmptyLine()]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnerLoading, setPartnerLoading] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [productLoading, setProductLoading] = useState(false);
  const [warehouses, setWarehouses] = useState<ApiWarehouse[]>([]);
  const [warehouseLoading, setWarehouseLoading] = useState(false);
  const [locations, setLocations] = useState<ApiLocation[]>([]);
  const [locationLoading, setLocationLoading] = useState(false);
  const [orderNumber, setOrderNumber] = useState('');
  const [orderNumberLoading, setOrderNumberLoading] = useState(false);
  const [orderNumberError, setOrderNumberError] = useState<string | null>(null);
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [taxTypes, setTaxTypes] = useState<TaxType[]>([]);
  const [taxLoading, setTaxLoading] = useState(false);
  const [taxLoadError, setTaxLoadError] = useState<string | null>(null);
  const [taxModalOpen, setTaxModalOpen] = useState(false);
  const [pendingTaxLineId, setPendingTaxLineId] = useState<string | null>(null);
  const [newTaxName, setNewTaxName] = useState('');
  const [newTaxRate, setNewTaxRate] = useState('0');
  const [newTaxMode, setNewTaxMode] = useState<TaxMode>('exclusive');
  const [taxNameError, setTaxNameError] = useState<string | null>(null);
  const [taxRateError, setTaxRateError] = useState<string | null>(null);
  const [taxCreating, setTaxCreating] = useState(false);
  const showToast = useToast();

  const lineSummaries = useMemo<LineSummary[]>(() => {
    return lines.map((line) => {
      const quantity = Number(line.quantity) || 0;
      const unitPrice = Number(line.unitPrice) || 0;
      const rawAmount = quantity * unitPrice;
      const taxType = taxTypes.find((type) => type.id === line.taxTypeId) ?? null;
      let base = roundToWon(rawAmount);
      let tax = 0;
      let total = base;

      if (taxType && taxType.rate > 0) {
        if (taxType.mode === 'exclusive') {
          tax = roundToWon(base * taxType.rate);
          total = base + tax;
        } else {
          const divisor = 1 + taxType.rate;
          base = roundToWon(rawAmount / divisor);
          tax = roundToWon(rawAmount - base);
          total = base + tax;
        }
      }

      return {
        lineId: line.id,
        base,
        tax,
        total,
        taxType,
      };
    });
  }, [lines, taxTypes]);

  const totals = useMemo(() => {
    const baseTotal = lineSummaries.reduce((sum, entry) => sum + entry.base, 0);
    const lineTotal = lineSummaries.reduce((sum, entry) => sum + entry.total, 0);
    const taxTotal = lineSummaries.reduce((sum, entry) => sum + entry.tax, 0);
    const breakdownMap = new Map<string, TaxBreakdownEntry>();

    lineSummaries.forEach(({ taxType, base, tax }) => {
      if (!taxType || tax === 0) {
        return;
      }
      const existing = breakdownMap.get(taxType.id);
      if (existing) {
        existing.base += base;
        existing.amount += tax;
      } else {
        breakdownMap.set(taxType.id, { taxType, base, amount: tax });
      }
    });

    return {
      lineTotal,
      baseTotal,
      taxTotal,
      total: baseTotal + taxTotal,
      taxBreakdown: Array.from(breakdownMap.values()),
    };
  }, [lineSummaries]);

  const lineSummaryMap = useMemo(() => {
    return new Map<string, LineSummary>(lineSummaries.map((entry) => [entry.lineId, entry]));
  }, [lineSummaries]);

  const buildSanitizedLines = useCallback(() => {
    return lines
      .map((line) => {
        const qty = Math.max(0, Math.round(Number(line.quantity) || 0));
        if (!line.productSku || qty <= 0) {
          return null;
        }
        const summary = lineSummaryMap.get(line.id);
        const selectedProduct = products.find((product) => product.sku === line.productSku) ?? null;
        const parsedUnitPrice = Number(line.unitPrice);
        const unitPrice = Number.isFinite(parsedUnitPrice) ? Math.round(parsedUnitPrice) : undefined;
        const amount = summary ? summary.total : Math.round(qty * (unitPrice ?? 0));
        const taxAmount = summary ? summary.tax : undefined;
        const taxType = summary?.taxType;
        const taxLabel = taxType
          ? `${taxType.name} (${(taxType.rate * 100).toFixed(0)}% ${
              taxType.mode === 'inclusive' ? '포함' : '별도'
            })`
          : undefined;
        return {
          sku: line.productSku,
          orderedQty: qty,
          productName: line.productName?.trim() || selectedProduct?.name,
          unit: selectedProduct?.unit ?? undefined,
          unitPrice,
          amount,
          taxAmount,
          taxLabel,
          currency: selectedProduct?.currency ?? undefined,
          taxTypeId: line.taxTypeId ?? undefined,
        };
      })
      .filter((entry): entry is CreatePurchaseOrderLine => Boolean(entry));
  }, [lineSummaryMap, lines, products]);

  const updateLine = (lineId: string, updater: (line: DraftLine) => DraftLine) => {
    setLines((prev) => prev.map((line) => (line.id === lineId ? updater(line) : line)));
  };

  const handleAddLine = () => {
    const defaultTaxId = taxTypes.find((type) => type.isDefault)?.id ?? null;
    setLines((prev) => [...prev, { ...createEmptyLine(), taxTypeId: defaultTaxId }]);
  };

  const handleRemoveLine = (lineId: string) => {
    setLines((prev) => (prev.length > 1 ? prev.filter((line) => line.id !== lineId) : prev));
  };

  const handleSaveDraft = useCallback(async () => {
    if (!supplier) {
      showToast('공급자를 선택하세요.', { tone: 'error' });
      return;
    }

    const sanitizedLines = buildSanitizedLines();
    if (!sanitizedLines.length) {
      showToast('최소 한 개 이상의 품목을 등록하세요.', { tone: 'error' });
      return;
    }

    const normalizedOrderNumber = orderNumber.trim();
    const normalizedOrderDate = orderDate.trim();
    const selectedPartner = partners.find((entry) => entry.id === supplier);
    setSavingDraft(true);
    try {
      const payload = {
        vendorId: supplier,
        vendorName: selectedPartner?.name,
        orderNumber: normalizedOrderNumber || undefined,
        orderDate: normalizedOrderDate || undefined,
        memo: memo || undefined,
        promisedDate: expectedDate || undefined,
        lines: sanitizedLines,
      };
      const savedDraft = draftId
        ? await updatePurchaseOrderDraft(draftId, payload)
        : await createPurchaseOrderDraft(payload);
      setDraftId(savedDraft.id);
      const storedDraft: PurchaseOrderDraft = {
        supplier,
        orderNumber,
        orderDate,
        expectedDate,
        memo,
        receivingMode,
        receivingNote,
        warehouse,
        location,
        lines,
        draftId: savedDraft.id,
      };
      window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(storedDraft));
      showToast('임시 저장되었습니다.', { tone: 'success' });
    } catch (error) {
      console.error('Failed to save draft', error);
      const description = error instanceof Error ? error.message : undefined;
      showToast('임시 저장에 실패했습니다.', { tone: 'error', description });
    } finally {
      setSavingDraft(false);
    }
  }, [
    supplier,
    orderNumber,
    orderDate,
    expectedDate,
    memo,
    receivingMode,
    receivingNote,
    warehouse,
    location,
    lines,
    partners,
    draftId,
    buildSanitizedLines,
    showToast,
    createPurchaseOrderDraft,
    updatePurchaseOrderDraft,
  ]);

  const buildReceiptOccurredAt = () => {
    return toIsoStartOfDay(expectedDate) ?? toIsoStartOfDay(orderDate) ?? new Date().toISOString();
  };

  const recordImmediateReceipts = useCallback(
    async (order: PurchaseOrder): Promise<number> => {
      const normalizedWarehouse = warehouse.trim();
      if (!normalizedWarehouse) {
        throw new Error('즉시입고 시 창고를 선택해주세요.');
      }
      const occurredAt = buildReceiptOccurredAt();
      const locationValue = location.trim();
      const memo = receivingNote.trim() || undefined;
      const payloads: CreateMovementPayload[] = order.lines
        .map((line) => {
          const pendingQty = Math.max(0, Math.round(line.orderedQty - (line.receivedQty ?? 0)));
          if (pendingQty <= 0) {
            return null;
          }
          return {
            type: 'RECEIPT',
            sku: line.sku,
            qty: pendingQty,
            toWarehouse: normalizedWarehouse,
            toLocation: locationValue || undefined,
            partnerId: order.vendorId,
            refNo: order.id,
            memo,
            occurredAt,
            userId: RECEIPT_MOVEMENT_USER_ID,
            poId: order.id,
            poLineId: line.id,
          };
        })
        .filter((entry): entry is CreateMovementPayload => Boolean(entry));

      if (!payloads.length) {
        return 0;
      }

      await Promise.all(payloads.map((payload) => submitMovement(payload)));
      return payloads.length;
    },
    [expectedDate, location, orderDate, receivingNote, warehouse],
  );

  const handleConfirmOrder = useCallback(async () => {
    if (!supplier) {
      showToast('공급자를 선택하세요.', { tone: 'error' });
      return;
    }
    const sanitizedLines = buildSanitizedLines();

    if (!sanitizedLines.length) {
      showToast('최소 한 개 이상의 품목을 등록하세요.', { tone: 'error' });
      return;
    }

    const normalizedOrderNumber = orderNumber.trim();
    const normalizedOrderDate = orderDate.trim();
    const selectedPartner = partners.find((entry) => entry.id === supplier);
    const isImmediateMode = receivingMode === '즉시입고';
    if (isImmediateMode && !warehouse.trim()) {
      showToast('즉시입고 시 창고를 선택해주세요.', { tone: 'error' });
      return;
    }
    setSubmittingOrder(true);
    try {
      const order = await createPurchaseOrder({
        vendorId: supplier,
        vendorName: selectedPartner?.name,
        orderNumber: normalizedOrderNumber || undefined,
        orderDate: normalizedOrderDate || undefined,
        memo: memo || undefined,
        promisedDate: expectedDate || undefined,
        lines: sanitizedLines,
      });
      let immediateReceiptCount = 0;
      if (isImmediateMode) {
        immediateReceiptCount = await recordImmediateReceipts(order);
      }
      setDraftId(null);
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
      const successMessage =
        isImmediateMode && immediateReceiptCount > 0
          ? `발주 등록 및 즉시입고 ${immediateReceiptCount.toLocaleString()}건이 기록되었습니다.`
          : '발주가 등록되었습니다.';
      showToast(successMessage, { tone: 'success' });
      navigate('/orders');
    } catch (error) {
      console.error('Failed to create purchase order', error);
      showToast('발주 확정에 실패했습니다.', {
        tone: 'error',
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSubmittingOrder(false);
    }
  }, [
    expectedDate,
    buildSanitizedLines,
    memo,
    navigate,
    orderNumber,
    partners,
    receivingMode,
    recordImmediateReceipts,
    showToast,
    supplier,
    warehouse,
  ]);

  const handleGoBack = useCallback(() => {
    navigate('/orders');
  }, [navigate]);

  const loadTaxTypes = useCallback(async () => {
    setTaxLoading(true);
    setTaxLoadError(null);
    try {
      const items = await listTaxTypes();
      setTaxTypes(items);
    } catch (error) {
      console.error('Failed to load tax types', error);
      setTaxLoadError('세금 목록을 불러오는 중 오류가 발생했습니다.');
    } finally {
      setTaxLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTaxTypes();
  }, [loadTaxTypes]);

  const defaultTaxTypeId = useMemo(() => taxTypes.find((type) => type.isDefault)?.id ?? null, [taxTypes]);

  useEffect(() => {
    if (!defaultTaxTypeId) {
      return;
    }
    setLines((prev) =>
      prev.map((line) =>
        line.taxTypeId ? line : { ...line, taxTypeId: defaultTaxTypeId },
      ),
    );
  }, [defaultTaxTypeId]);

  const handleTaxSelectChange = (lineId: string, value: string) => {
    if (value === TAX_ADD_KEY) {
      setPendingTaxLineId(lineId);
      setTaxModalOpen(true);
      return;
    }
    updateLine(lineId, (current) => ({ ...current, taxTypeId: value || null }));
  };

  const resetTaxModal = useCallback(() => {
    setTaxModalOpen(false);
    setPendingTaxLineId(null);
    setNewTaxName('');
    setNewTaxRate('0');
    setNewTaxMode('exclusive');
    setTaxNameError(null);
    setTaxRateError(null);
  }, []);

  const handleCreateTax = useCallback(async () => {
    const trimmedName = newTaxName.trim();
    const rateValue = Number(newTaxRate);
    if (!trimmedName) {
      setTaxNameError('세금명을 입력해 주세요.');
      return;
    }
    setTaxNameError(null);
    if (!Number.isFinite(rateValue) || rateValue < 0 || rateValue > 100) {
      setTaxRateError('세율은 0~100 사이여야 합니다.');
      return;
    }
    setTaxRateError(null);

    setTaxCreating(true);
    try {
      const created = await createTaxType({
        name: trimmedName,
        rate: rateValue / 100,
        mode: newTaxMode,
      });
      setTaxTypes((prev) => [...prev, created]);
      showToast('세금이 추가되었습니다.', { tone: 'success' });
      const targetLineId = pendingTaxLineId;
      resetTaxModal();
      if (targetLineId) {
        updateLine(targetLineId, (current) => ({ ...current, taxTypeId: created.id }));
      }
    } catch (error) {
      console.error('Failed to create tax type', error);
      showToast('세금 추가에 실패했습니다.', {
        tone: 'error',
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setTaxCreating(false);
    }
  }, [
    newTaxMode,
    newTaxName,
    newTaxRate,
    pendingTaxLineId,
    resetTaxModal,
    showToast,
  ]);

  const getProductStock = useCallback((product: Product) => {
    const inventorySum = (product.inventory ?? []).reduce((sum, entry) => sum + Math.max(0, entry.onHand ?? 0), 0);
    return inventorySum || Math.max(0, product.onHand ?? 0);
  }, []);

  const formatProductOptionLabel = useCallback(
    (product: Product) => `${product.name} (${product.sku}) · 재고 ${getProductStock(product).toLocaleString('ko-KR')}`,
    [getProductStock],
  );

  const handleProductSelection = (lineId: string, sku: string) => {
    const selection = products.find((product) => product.sku === sku);
    updateLine(lineId, (current) => ({
      ...current,
      productSku: sku,
      productName: selection ? selection.name : current.productName,
      unitPrice: selection?.supplyPrice != null ? formatPriceInput(selection.supplyPrice) : current.unitPrice,
    }));
  };

  const suggestOrderNumber = useCallback(async () => {
    setOrderNumberLoading(true);
    setOrderNumberError(null);
    try {
      const trimmedOrderDate = orderDate.trim();
      if (!trimmedOrderDate) {
        throw new Error('발주일을 선택해 주세요.');
      }
      const suggestion = await getNextPurchaseOrderNumber(trimmedOrderDate);
      setOrderNumber(suggestion.orderNumber);
    } catch (error) {
      console.error('Failed to suggest order number', error);
      setOrderNumberError(
        error instanceof Error ? error.message : '주문 번호 자동 추천에 실패했습니다. 다시 시도해 주세요.',
      );
    } finally {
      setOrderNumberLoading(false);
    }
  }, [orderDate]);

  const loadPartners = useCallback(async () => {
    setPartnerLoading(true);
    try {
      const items = await listPartners({ type: 'SUPPLIER' });
      setPartners(items);
    } catch (error) {
      console.error('Failed to load partners', error);
    } finally {
      setPartnerLoading(false);
    }
  }, []);

  const loadProducts = useCallback(async () => {
    setProductLoading(true);
    try {
      const items = await fetchProducts();
      setProducts(items);
    } catch (error) {
      console.error('Failed to load products', error);
    } finally {
      setProductLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPartners();
  }, [loadPartners]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  const loadWarehouses = useCallback(async () => {
    setWarehouseLoading(true);
    try {
      const response = await fetchWarehouses({ pageSize: 100 });
      setWarehouses(response.items);
    } catch (error) {
      console.error('Failed to load warehouses', error);
    } finally {
      setWarehouseLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWarehouses();
  }, [loadWarehouses]);

  const loadLocations = useCallback(async (warehouseCode: string) => {
    setLocationLoading(true);
    try {
      const response = await fetchLocations(warehouseCode, { pageSize: 100 });
      setLocations(response.items ?? []);
    } catch (error) {
      console.error('Failed to load locations', error);
      setLocations([]);
    } finally {
      setLocationLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!warehouse) {
      setLocations([]);
      setLocation('');
      return;
    }
    setLocation('');
    void loadLocations(warehouse);
  }, [warehouse, loadLocations]);

  const isWarehouseEnabled = receivingMode === '즉시입고';
  const isImmediate = receivingMode === '즉시입고';

  useEffect(() => {
    if (isImmediate) {
      setExpectedDate(orderDate);
    }
  }, [isImmediate, orderDate]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as PurchaseOrderDraft;
      setSupplier(parsed.supplier || '');
      setOrderNumber(parsed.orderNumber || '');
      setOrderDate(parsed.orderDate || new Date().toISOString().slice(0, 10));
      setExpectedDate(parsed.expectedDate || '');
      setMemo(parsed.memo || '');
      setReceivingMode(parsed.receivingMode || '즉시입고');
      setReceivingNote(parsed.receivingNote || '');
      setWarehouse(parsed.warehouse || '');
      setLocation(parsed.location || '');
      setDraftId(parsed.draftId ?? null);
      setLines(parsed.lines && parsed.lines.length ? parsed.lines : [createEmptyLine()]);
    } catch (error) {
      console.error('Failed to restore draft', error);
    }
  }, []);

  useEffect(() => {
    if (!isWarehouseEnabled) {
      setLocation('');
    }
  }, [isWarehouseEnabled]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">구매 발주</p>
          <h1 className="mt-1 text-3xl font-semibold text-slate-900">발주서</h1>
          <p className="mt-2 text-sm text-slate-500">공급자를 선택하고 발주 내역을 입력하세요. 초안은 언제든지 다시 편집할 수 있습니다.</p>
        </div>
        <div>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="rounded-md border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
          >
            목록으로
          </button>
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">공급자</h2>
            <p className="text-sm text-slate-500">공급자 마스터에 등록된 정보를 기반으로 발주가 생성됩니다.</p>
          </div>
          <button type="button" className="text-sm font-semibold text-indigo-600">신규 공급자 등록</button>
        </header>
        <div className="mt-4 max-w-xl">
          <label htmlFor="supplier" className="text-sm font-medium text-slate-700">공급자 선택</label>
          <select
            id="supplier"
            value={supplier}
            onChange={(event) => setSupplier(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none"
          >
            <option value="" disabled={partnerLoading}>
              {partnerLoading ? '공급자를 불러오는 중입니다...' : '공급자를 선택하세요'}
            </option>
            {partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.name}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">제품 선택</h2>
            <p className="text-sm text-slate-500">제품 코드를 검색하거나 바코드로 손쉽게 추가하세요.</p>
          </div>
        </div>

          <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="space-y-3">
                <div className="rounded-xl border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-3 text-left">제품</th>
                        <th className="px-4 py-3 text-left">SKU</th>
                        <th className="px-4 py-3 text-left">세금</th>
                        <th className="px-4 py-3 text-right">수량</th>
                        <th className="px-4 py-3 text-right">구매가</th>
                        <th className="px-4 py-3 text-right">금액</th>
                        <th className="px-4 py-3 text-center">삭제</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line, index) => {
                        const quantity = Number(line.quantity) || 0;
                        const unitPrice = Number(line.unitPrice) || 0;
                        const selectedProduct = products.find((product) => product.sku === line.productSku) ?? null;
                        const summary = lineSummaryMap.get(line.id);
                        const displayedAmount = summary ? summary.total : Math.round(quantity * unitPrice);
                        return (
                          <tr key={line.id} className={index % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}>
                            <td className="px-4 py-3">
                              <select
                                value={line.productSku}
                                onChange={(event) => handleProductSelection(line.id, event.target.value)}
                                className="w-full rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none"
                              >
                                <option value="" disabled={productLoading}>
                                  {productLoading ? '상품 목록을 불러오는 중입니다...' : '제품을 선택하세요'}
                                </option>
                                {products.map((product) => (
                                  <option key={product.sku} value={product.sku}>
                                    {formatProductOptionLabel(product)}
                                  </option>
                                ))}
                              </select>
                              {selectedProduct && (
                                <p className="mt-1 text-xs text-slate-500">
                                  현재 재고: {getProductStock(selectedProduct).toLocaleString('ko-KR')} {selectedProduct.unit ?? ''}
                                </p>
                              )}
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              {selectedProduct?.sku ?? '—'}
                            </td>
                            <td className="px-4 py-3">
                              <select
                                value={line.taxTypeId ?? ''}
                                onChange={(event) => handleTaxSelectChange(line.id, event.target.value)}
                                disabled={taxLoading}
                                className="w-full rounded-md border border-slate-200 px-2 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                              >
                                <option value="">없음</option>
                                {taxTypes.map((taxType) => (
                                  <option key={taxType.id} value={taxType.id}>
                                    {taxType.name} ({(taxType.rate * 100).toFixed(0)}%{taxType.mode === 'inclusive' ? ' 포함' : ''})
                                  </option>
                                ))}
                                <option value={TAX_ADD_KEY}>+ 추가하기</option>
                              </select>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <input
                                type="number"
                                min="0"
                                value={line.quantity}
                                onChange={(event) =>
                                  updateLine(line.id, (current) => ({ ...current, quantity: event.target.value }))
                                }
                                className="w-full rounded-md border border-slate-200 px-2 py-1 text-right text-sm focus:border-indigo-500 focus:outline-none"
                              />
                            </td>
                            <td className="px-4 py-3 text-right">
                              <input
                                type="text"
                                value={formatPurchasePriceForDisplay(line.unitPrice)}
                                onChange={(event) =>
                                  updateLine(line.id, (current) => ({
                                    ...current,
                                    unitPrice: normalizePurchasePriceEntry(event.target.value),
                                  }))
                                }
                                className="w-full rounded-md border border-slate-200 px-2 py-1 text-right text-sm focus:border-indigo-500 focus:outline-none"
                              />
                            </td>
                            <td className="px-4 py-3 text-right font-semibold text-slate-800">
                              {formatCurrency(displayedAmount)}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemoveLine(line.id)}
                                className="text-xs font-semibold text-rose-600 hover:text-rose-500"
                                disabled={lines.length <= 1}
                              >
                                삭제
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
            <button
              type="button"
              onClick={handleAddLine}
              className="rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            >
              + 품목 추가
            </button>
          </div>

            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5 text-sm">
              {taxLoadError && <p className="text-xs text-rose-600">{taxLoadError}</p>}
              <dl className="space-y-3">
                <div className="flex justify-between text-slate-600">
                  <dt>소계</dt>
                  <dd>{formatCurrency(totals.lineTotal)}</dd>
                </div>
                <div className="flex justify-between text-slate-600">
                  <dt>총액 (세금 제외)</dt>
                  <dd>{formatCurrency(totals.baseTotal)}</dd>
                </div>
                {totals.taxBreakdown.map((entry) => (
                  <div key={entry.taxType.id} className="flex items-center justify-between text-slate-600">
                    <dt className="text-xs text-slate-600">
                      {entry.taxType.name} ({formatCurrency(entry.base)}에 대한 {(entry.taxType.rate * 100).toFixed(0)}%
                      {entry.taxType.mode === 'inclusive' ? ' 포함' : ''})
                    </dt>
                    <dd className="text-slate-800">{formatCurrency(entry.amount)}</dd>
                  </div>
                ))}
                <div className="flex justify-between text-base font-semibold text-slate-900">
                  <dt>총액</dt>
                  <dd>{formatCurrency(totals.total)}</dd>
                </div>
              </dl>
            </div>
        </div>
      </section>

      <section className="grid gap-5 md:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">주문 정보</h2>
          <div className="mt-4 space-y-4 text-sm">
            <div>
              <label className="block text-sm font-medium text-slate-700">주문 번호</label>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={orderNumber}
                  onChange={(event) => setOrderNumber(event.target.value.toUpperCase())}
                  placeholder="예: PO-20251110-001"
                  className="flex-1 rounded-xl border border-slate-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={suggestOrderNumber}
                  disabled={orderNumberLoading}
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:bg-indigo-700 disabled:bg-indigo-400"
                >
                  {orderNumberLoading ? '추천 중…' : '자동 추천'}
                </button>
              </div>
              {orderNumberError && (
                <p className="mt-1 text-xs text-rose-600">{orderNumberError}</p>
              )}
              <p className="mt-1 text-xs text-slate-500">
                자동 추천된 주문번호는 서버에서 중복 검증되며, 수동 입력보다 자동 추천을 우선 사용하시길 권장합니다.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-slate-700">발주일</label>
                <input
                  type="date"
                  value={orderDate}
                  onChange={(event) => setOrderDate(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">입고 예정일</label>
                <input
                  type="date"
                  value={expectedDate}
                  onChange={(event) => setExpectedDate(event.target.value)}
                  disabled={isImmediate}
                  className={`mt-1 w-full rounded-xl border border-slate-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none ${
                    isImmediate ? 'cursor-not-allowed bg-slate-50 text-slate-400' : ''
                  }`}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">입고 설정</h2>
          <div className="mt-4 space-y-4 text-sm">
            <div>
              <label className="block text-sm font-medium text-slate-700">입고 방식</label>
              <select
                value={receivingMode}
                onChange={(event) => setReceivingMode(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              >
                <option value="즉시입고">즉시입고 </option>
                <option value="지연입고">지연입고 </option>
              </select>
              <p className="mt-1 text-xs text-slate-500">즉시입고는 발주 즉시 재고가 증가하며, 지연입고는 입고 처리 전까지 재고에 반영되지 않습니다.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">입고 참고</label>
              <textarea
                value={receivingNote}
                onChange={(event) => setReceivingNote(event.target.value)}
                rows={3}
                placeholder="창고팀 전달 사항을 입력하세요"
                className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">창고 선택</label>
            <select
              value={warehouse}
              onChange={(event) => setWarehouse(event.target.value)}
              disabled={!isWarehouseEnabled || warehouseLoading}
              className={`mt-1 w-full rounded-xl border border-slate-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none ${
                !isWarehouseEnabled || warehouseLoading ? 'cursor-not-allowed bg-slate-50 text-slate-400' : ''
              }`}
            >
              <option value="" disabled>
                {warehouseLoading ? '창고 목록을 불러오는 중입니다...' : '창고를 선택하세요'}
              </option>
              {warehouses.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.name} ({entry.code})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">상세 위치</label>
            <select
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              disabled={!warehouse || !isWarehouseEnabled || locationLoading}
              className={`mt-1 w-full rounded-xl border border-slate-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none ${
                !warehouse || !isWarehouseEnabled || locationLoading ? 'cursor-not-allowed bg-slate-50 text-slate-400' : ''
              }`}
            >
              <option value="" disabled>
                {locationLoading ? '상세 위치를 불러오는 중입니다...' : '상세 위치를 선택하세요'}
              </option>
              {locations.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.description ?? entry.code}
                </option>
              ))}
            </select>
          </div>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={handleGoBack}
          className="rounded-md border border-slate-200 px-5 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
        >
          뒤로가기
        </button>
        <button
          type="button"
          onClick={handleSaveDraft}
          disabled={savingDraft}
          className="rounded-md border border-slate-300 px-5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:border-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed"
        >
          {savingDraft ? '임시 저장 중…' : '임시 저장'}
        </button>
        <button
          type="button"
          onClick={handleConfirmOrder}
          disabled={submittingOrder}
          className="rounded-md bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 hover:bg-indigo-700 disabled:bg-indigo-500"
        >
          {submittingOrder ? '발주 확정 중…' : '발주 확정'}
        </button>
      </div>
      <Modal isOpen={taxModalOpen} onClose={resetTaxModal} title="세금 추가">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreateTax();
          }}
          className="space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-slate-700">이름</label>
            <input
              type="text"
              value={newTaxName}
              onChange={(event) => setNewTaxName(event.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
            {taxNameError && <p className="text-xs text-rose-600">{taxNameError}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">세율</label>
            <div className="mt-1 flex gap-2">
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={newTaxRate}
                onChange={(event) => setNewTaxRate(event.target.value)}
                className="w-24 rounded-xl border border-slate-200 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <span className="px-2 py-2 text-sm text-slate-500">%</span>
              <select
                value={newTaxMode}
                onChange={(event) => setNewTaxMode(event.target.value as TaxMode)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              >
                <option value="exclusive">별도</option>
                <option value="inclusive">포함</option>
              </select>
            </div>
            {taxRateError && <p className="text-xs text-rose-600">{taxRateError}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={resetTaxModal} className="rounded-xl border border-slate-200 px-5 py-2 text-sm font-semibold text-slate-600">
              취소
            </button>
            <button
              type="submit"
              disabled={taxCreating}
              className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 hover:bg-indigo-700 disabled:bg-indigo-500"
            >
              {taxCreating ? '저장 중…' : '등록'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default NewPurchaseOrderPage;
