import * as React from 'react';

import Modal from '../../../../components/ui/Modal';
import type { Partner } from '../../../services/orders';
import {
  getPurchaseOrder,
  getSalesOrder,
  type PurchaseOrder,
  type SalesOrder,
} from '../../../services/orders';
import type { Product } from '../../../services/products';
import { formatKstDateTimeLabelFromUtc } from '@/shared/datetime/kst';

export type OrderKind = 'purchase' | 'sales';

export interface OrderDetailSummary {
  id: string;
  orderKind: OrderKind;
  partnerName?: string | null;
  scheduledDate?: string; // already formatted label if provided
  warehouseLocationLabel?: string;
}

interface OrderDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: string;
  orderKind: OrderKind;
  partners: Partner[];
  products?: Product[] | null;
  summary?: OrderDetailSummary | null;
}

type LoadedOrder = (PurchaseOrder | SalesOrder) & { type: 'PURCHASE' | 'SALES' };

const findPartnerName = (partners: Partner[], id?: string | null) =>
  partners.find((p) => p.id === id)?.name ?? null;

const findProduct = (products: Product[] | null | undefined, sku: string) =>
  products?.find((p) => p.sku === sku);

const OrderDetailModal: React.FC<OrderDetailModalProps> = ({
  isOpen,
  onClose,
  orderId,
  orderKind,
  partners,
  products,
  summary,
}) => {
  const [status, setStatus] = React.useState<'idle' | 'loading' | 'success' | 'error'>(
    'idle',
  );
  const [order, setOrder] = React.useState<LoadedOrder | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    let mounted = true;
    setStatus('loading');
    setError(null);
    const run = async () => {
      try {
        const data =
          orderKind === 'purchase'
            ? await getPurchaseOrder(orderId)
            : await getSalesOrder(orderId);
        if (!mounted) return;
        if (!data) {
          setError('주문 정보를 찾을 수 없습니다.');
          setStatus('error');
          return;
        }
        setOrder(data as LoadedOrder);
        setStatus('success');
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[OrderDetailModal] load failed', e);
        if (!mounted) return;
        setError('상세 정보를 불러오지 못했습니다.');
        setStatus('error');
      }
    };
    void run();
    return () => {
      mounted = false;
    };
  }, [isOpen, orderId, orderKind]);

  const title = orderKind === 'purchase' ? '입고 내역' : '출고 내역';

  const partnerName = React.useMemo(() => {
    if (summary?.partnerName) return summary.partnerName;
    if (order) return findPartnerName(partners, order.partnerId);
    return null;
  }, [partners, order, summary?.partnerName]);

  const scheduledLabel = React.useMemo(() => {
    if (summary?.scheduledDate) return summary.scheduledDate;
    if (order?.scheduledAt) return formatKstDateTimeLabelFromUtc(order.scheduledAt) ?? '';
    return '';
  }, [order?.scheduledAt, summary?.scheduledDate]);

  const locationLabel = React.useMemo(() => {
    if (summary?.warehouseLocationLabel) return summary.warehouseLocationLabel;
    if (!order) return '';
    const w = order.warehouseCode ?? '미지정 창고';
    const l = order.detailedLocationCode ?? '미지정 위치';
    return `${w} > ${l}`;
  }, [order, summary?.warehouseLocationLabel]);

  const renderLines = () => {
    if (!order) return null;
    const isPurchase = orderKind === 'purchase';
    const lines = isPurchase
      ? (order as PurchaseOrder).items.map((item) => ({
          sku: item.sku,
          quantity: Math.max(0, Math.round(item.receivedQty ?? 0)),
          unit: item.unit,
        }))
      : (order as SalesOrder).items.map((item) => ({
          sku: item.sku,
          quantity: Math.max(0, Math.round(item.shippedQty ?? 0)),
          unit: item.unit,
        }));

    if (lines.length === 0) {
      return (
        <div className="px-4 py-10 text-center text-sm text-slate-400">등록된 품목이 없습니다.</div>
      );
    }

    return (
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 text-left font-medium">사진</th>
              <th className="px-4 py-3 text-left font-medium">제품명</th>
              <th className="px-4 py-3 text-right font-medium">수량</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 text-slate-700">
            {lines.map((line) => {
              const product = findProduct(products ?? null, line.sku);
              const sign = isPurchase ? '+' : '-';
              return (
                <tr key={`${line.sku}`} className="align-top">
                  <td className="whitespace-nowrap px-4 py-3">
                    {product?.imageUrl ? (
                      <img
                        src={product.imageUrl}
                        alt={product.name}
                        className="h-10 w-10 rounded-md object-cover"
                      />
                    ) : (
                      <div className="h-10 w-10 rounded-md bg-slate-100" />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-slate-800">
                      {product?.name ?? line.sku}
                    </div>
                    <div className="text-xs text-slate-500">{product ? product.sku : line.sku}</div>
                  </td>
                  <td className={`whitespace-nowrap px-4 py-3 text-right text-sm font-semibold ${
                    isPurchase ? 'text-emerald-600' : 'text-rose-600'
                  }`}>
                    {sign}
                    {line.quantity.toLocaleString('ko-KR')} {line.unit || 'EA'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} widthClassName="max-w-3xl">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h4 className={`text-lg font-semibold ${orderKind === 'sales' ? 'text-rose-600' : 'text-emerald-600'}`}>
            {title}
          </h4>
        </div>

        {/* Summary */}
        <dl className="grid grid-cols-3 gap-4">
          <div>
            <dt className="text-xs font-semibold text-slate-500">위치</dt>
            <dd className="text-sm font-medium text-slate-800">{locationLabel}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-slate-500">{orderKind === 'purchase' ? '입고일' : '출고일'}</dt>
            <dd className="text-sm font-medium text-slate-800">{scheduledLabel}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-slate-500">거래처</dt>
            <dd className="text-sm font-medium text-slate-800">{partnerName ?? '미지정'}</dd>
          </div>
        </dl>

        {/* Lines / Body */}
        {status === 'loading' ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500">불러오는 중...</div>
        ) : status === 'error' ? (
          <div className="px-4 py-10 text-center text-sm text-rose-600">{error ?? '오류가 발생했습니다.'}</div>
        ) : (
          renderLines()
        )}

        {/* Footer */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
          >
            확인
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default OrderDetailModal;

