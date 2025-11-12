import React, { useState } from 'react';
import {
  createPurchaseOrder as apiCreatePurchaseOrder,
  type PurchaseOrderLine,
} from '../../../../services/purchaseOrders';

interface PurchaseCreatePageProps {
  onClose: () => void;
  onCreated: () => void;
}

const PurchaseCreatePage: React.FC<PurchaseCreatePageProps> = ({ onClose, onCreated }) => {
  const [vendorId, setVendorId] = useState('');
  const [promisedDate, setPromisedDate] = useState('');
  const [lines, setLines] = useState<Array<{ sku: string; orderedQty: number }>>([{ sku: '', orderedQty: 0 }]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const sanitized = lines
      .map((l) => ({ sku: l.sku.trim().toUpperCase(), orderedQty: Math.max(0, Math.round(l.orderedQty)) }))
      .filter((entry) => entry.sku && entry.orderedQty > 0);

    if (!vendorId.trim()) {
      setError('공급사 ID를 입력해 주세요.');
      return;
    }
    if (!sanitized.length) {
      setError('SKU와 수량을 1개 이상 입력해 주세요.');
      return;
    }

    setProcessing(true);
    try {
      await apiCreatePurchaseOrder({
        vendorId: vendorId.trim(),
        promisedDate: promisedDate || undefined,
        lines: sanitized,
      });
      setVendorId('');
      setPromisedDate('');
      setLines([{ sku: '', orderedQty: 0 }]);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : '발주서 생성에 실패했습니다.');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-6">
      <div className="mx-auto w-full max-w-4xl rounded-3xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">새 발주서 작성</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm font-medium text-slate-500 hover:text-slate-800"
          >
            닫기
          </button>
        </div>
        <form className="mt-6 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-1 text-sm">
            <label className="block font-semibold text-slate-700">공급사</label>
            <input
              className="w-full rounded-xl border border-slate-200 px-4 py-3 shadow-sm focus:border-indigo-500 focus:outline-none"
              placeholder="공급사 ID 입력"
              value={vendorId}
              onChange={(event) => setVendorId(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <label className="block font-semibold text-slate-700">입고일</label>
              <input
                type="date"
                className="w-full rounded-xl border border-slate-200 px-4 py-3"
                value={promisedDate}
                onChange={(event) => setPromisedDate(event.target.value)}
              />
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between text-sm font-semibold text-slate-700">
              <span>제품 선택</span>
            </div>
            <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              {lines.map((line, index) => (
                <div key={index} className="flex gap-3">
                  <input
                    className="flex-1 rounded-xl border border-slate-200 px-4 py-2"
                    placeholder="SKU"
                    value={line.sku}
                    onChange={(e) => {
                      const next = [...lines];
                      next[index] = { ...next[index], sku: e.target.value };
                      setLines(next);
                    }}
                  />
                  <input
                    type="number"
                    className="w-28 rounded-xl border border-slate-200 px-4 py-2"
                    placeholder="수량"
                    value={line.orderedQty}
                    onChange={(e) => {
                      const next = [...lines];
                      next[index] = { ...next[index], orderedQty: Number(e.target.value) };
                      setLines(next);
                    }}
                  />
                  <button
                    type="button"
                    className="rounded-xl border border-slate-300 px-3 py-2 text-xs text-slate-500"
                    onClick={() => {
                      setLines((prev) => prev.filter((_, idx) => idx !== index));
                    }}
                    aria-label="라인 삭제"
                  >
                    삭제
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="text-sm font-semibold text-indigo-600"
                onClick={() => setLines((prev) => [...prev, { sku: '', orderedQty: 0 }])}
              >
                + 행 추가
              </button>
            </div>
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <div className="flex items-center justify-between text-sm text-slate-500">
            <span>임시 저장하면 나중에 다시 편집 가능합니다.</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-slate-200 px-5 py-2 text-sm font-semibold text-slate-600"
              >
                취소
              </button>
              <button
                type="submit"
                disabled={processing}
                className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 disabled:opacity-60"
              >
                {processing ? '저장 중…' : '발주 확정'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PurchaseCreatePage;
