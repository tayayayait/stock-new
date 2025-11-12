import React, { useMemo, useState } from 'react';
import Modal from '../../../../../components/ui/Modal';
import { type PurchaseOrder, type PurchaseOrderLine } from '../../../../services/purchaseOrders';
import { getPurchaseStatusLabel } from '../../../utils/purchaseStatus';

interface PurchaseDetailModalProps {
  isOpen: boolean;
  order: PurchaseOrder | null;
  onClose: () => void;
  onReceive: (options: { location: string; date?: string; memo?: string }) => Promise<void>;
}

const PurchaseDetailModal: React.FC<PurchaseDetailModalProps> = ({ isOpen, order, onClose, onReceive }) => {
  const [tab, setTab] = useState<'info' | 'lines'>('info');
  const [location, setLocation] = useState('');
  const [date, setDate] = useState('');
  const [memo, setMemo] = useState('');
  const [receiving, setReceiving] = useState(false);
  const [receiveError, setReceiveError] = useState<string | null>(null);

  const totalOrdered = useMemo(
    () => order?.lines.reduce((sum, line) => sum + line.orderedQty, 0) ?? 0,
    [order],
  );
  const totalReceived = useMemo(
    () => order?.lines.reduce((sum, line) => sum + line.receivedQty, 0) ?? 0,
    [order],
  );

  const handleReceive = async () => {
    if (!order) return;
    setReceiving(true);
    setReceiveError(null);
    try {
      await onReceive({ location, date: date || undefined, memo: memo || undefined });
    } catch (err) {
      setReceiveError(err instanceof Error ? err.message : '일괄 입고에 실패했습니다.');
    } finally {
      setReceiving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="발주서 상세" widthClassName="max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-slate-400">PO 번호</div>
          <div className="text-lg font-semibold text-slate-900">
            {order?.orderNumber ?? order?.id ?? '—'}
          </div>
        </div>
        <button
          type="button"
          className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"
          disabled={!order || receiving}
          onClick={handleReceive}
        >
          {receiving ? '입고 처리 중…' : '일괄 입고'}
        </button>
      </div>
      <div className="mt-4 border-b">
        <nav className="flex gap-4 text-sm font-medium">
          <button
            type="button"
            className={`px-3 py-2 ${tab === 'info' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-500'}`}
            onClick={() => setTab('info')}
          >
            발주 정보
          </button>
          <button
            type="button"
            className={`px-3 py-2 ${tab === 'lines' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-500'}`}
            onClick={() => setTab('lines')}
          >
            입고 현황
          </button>
        </nav>
      </div>
      <div className="mt-4 space-y-4">
        {tab === 'info' ? (
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-slate-400">공급사</div>
              <div className="text-base font-semibold text-slate-900">
                {order?.vendorName ?? order?.vendorId ?? '—'}
              </div>
            </div>
            <div>
              <div className="text-slate-400">상태</div>
              <div className="text-base font-semibold text-slate-900">
                {order ? getPurchaseStatusLabel(order.status) : '—'}
              </div>
            </div>
            <div>
              <div className="text-slate-400">주문일</div>
              <div className="text-base font-semibold text-slate-900">
                {order ? new Date(order.createdAt).toLocaleDateString() : '—'}
              </div>
            </div>
            <div>
              <div className="text-slate-400">입고일</div>
              <div className="text-base font-semibold text-slate-900">{order?.promisedDate ?? '—'}</div>
            </div>
          </div>
        ) : (
          <div>
            <div className="text-sm text-slate-400">합계</div>
            <div className="text-base font-semibold text-slate-900">
              총 {totalOrdered.toLocaleString()} EA / 입고 {totalReceived.toLocaleString()} EA
            </div>
          </div>
        )}
        <div>
          <h3 className="text-sm font-semibold text-slate-700">라인 목록</h3>
          <div className="mt-2 overflow-hidden rounded-xl border bg-white">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">SKU</th>
                  <th className="px-4 py-3">요청</th>
                  <th className="px-4 py-3">입고</th>
                  <th className="px-4 py-3">잔여</th>
                </tr>
              </thead>
              <tbody>
                {order?.lines.map((line) => {
                  const remaining = Math.max(0, line.orderedQty - line.receivedQty);
                  return (
                    <tr key={line.id} className="border-t border-slate-100">
                      <td className="px-4 py-3">{line.sku}</td>
                      <td className="px-4 py-3">{line.orderedQty.toLocaleString()}</td>
                      <td className="px-4 py-3">{line.receivedQty.toLocaleString()}</td>
                      <td className="px-4 py-3 text-indigo-700">{remaining.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="text-sm font-semibold text-slate-700">입고 정보</div>
          <div>
            <label className="block text-xs text-slate-500">위치</label>
            <input
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="예: WH-001"
              className="w-full rounded-md border px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500">날짜</label>
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="w-full rounded-md border px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500">메모</label>
            <textarea
              rows={3}
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
              className="w-full rounded-md border px-3 py-2"
              placeholder="입고 메모 (선택)"
            />
          </div>
          {receiveError && <p className="text-sm text-rose-600">{receiveError}</p>}
        </div>
      </div>
    </Modal>
  );
};

export default PurchaseDetailModal;
