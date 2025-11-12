import React, { useEffect, useState } from 'react';
import Modal from '../../../../../components/ui/Modal';
import { listSalesOrders, createSalesOrder as apiCreateSalesOrder, type SalesOrder } from '../../../../services/salesOrders';

const formatDate = (value: string | null): string => (value ? new Date(value).toLocaleDateString() : '—');

const badgeClass = (status: SalesOrder['status']) => {
  if (status === 'closed') {
    return 'bg-emerald-100 text-emerald-700';
  }
  if (status === 'canceled') {
    return 'bg-rose-100 text-rose-600';
  }
  if (status === 'packed' || status === 'picking') {
    return 'bg-amber-100 text-amber-700';
  }
  return 'bg-slate-100 text-slate-700';
};

const SalesPage: React.FC = () => {
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [promisedDate, setPromisedDate] = useState('');
  const [lines, setLines] = useState<Array<{ sku: string; orderedQty: number }>>([
    { sku: '', orderedQty: 0 },
  ]);

  const load = () => {
    setLoading(true);
    setError(null);
    listSalesOrders()
      .then(setOrders)
      .catch((err) => setError(err instanceof Error ? err.message : '불러오는 중 오류 발생'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">판매 주문서</h2>
          <p className="text-sm text-slate-500">출고 주문과 연동할 수 있도록 목록만 우선 제공합니다.</p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          새 주문서 작성
        </button>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white/80 p-4">
        {error ? (
          <p className="text-sm text-rose-500">{error}</p>
        ) : loading ? (
          <p className="text-sm text-slate-500">불러오는 중…</p>
        ) : orders.length === 0 ? (
          <p className="text-sm text-slate-500">등록된 주문서가 없습니다.</p>
        ) : (
          <div className="overflow-hidden rounded-2xl border">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">번호</th>
                  <th className="px-4 py-3">고객</th>
                  <th className="px-4 py-3">상태</th>
                  <th className="px-4 py-3">총 주문</th>
                  <th className="px-4 py-3">출고</th>
                  <th className="px-4 py-3">출하예정일</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const totalOrdered = order.lines.reduce((sum, line) => sum + line.orderedQty, 0);
                  const totalShipped = order.lines.reduce((sum, line) => sum + line.shippedQty, 0);
                  return (
                    <tr key={order.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium">{order.id}</td>
                      <td className="px-4 py-3">{order.customerId}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${badgeClass(order.status)}`}>
                          {order.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">{totalOrdered.toLocaleString()} EA</td>
                      <td className="px-4 py-3 text-slate-600">
                        {totalShipped.toLocaleString()} / {totalOrdered.toLocaleString()}
                      </td>
                      <td className="px-4 py-3">{formatDate(order.promisedDate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title="새 주문서 작성" widthClassName="max-w-2xl">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (creating) return;
            setFormError(null);
            const sanitized = lines
              .map((l) => ({ sku: l.sku.trim().toUpperCase(), orderedQty: Math.max(0, Math.round(l.orderedQty)) }))
              .filter((l) => l.sku && l.orderedQty > 0);
            if (!customerId.trim()) {
              setFormError('고객을 입력하세요.');
              return;
            }
            if (sanitized.length === 0) {
              setFormError('SKU와 수량을 1개 이상 입력하세요.');
              return;
            }
            setCreating(true);
            try {
              await apiCreateSalesOrder({ customerId: customerId.trim(), promisedDate: promisedDate || undefined, lines: sanitized });
              setCreateOpen(false);
              setCustomerId('');
              setPromisedDate('');
              setLines([{ sku: '', orderedQty: 0 }]);
              setError(null);
              setLoading(true);
              listSalesOrders().then(setOrders).finally(() => setLoading(false));
            } catch (err) {
              setFormError(err instanceof Error ? err.message : '주문서 생성에 실패했습니다.');
            } finally {
              setCreating(false);
            }
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-slate-700">고객 ID</span>
              <input
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="w-full rounded-md border px-3 py-2"
                placeholder="예: CUST-001"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-slate-700">출하예정일 (선택)</span>
              <input
                type="date"
                value={promisedDate}
                onChange={(e) => setPromisedDate(e.target.value)}
                className="w-full rounded-md border px-3 py-2"
              />
            </label>
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold text-slate-700">라인 항목</div>
            <div className="space-y-2">
              {lines.map((line, idx) => (
                <div key={idx} className="grid grid-cols-12 items-center gap-2">
                  <input
                    className="col-span-7 rounded-md border px-3 py-2"
                    placeholder="SKU"
                    value={line.sku}
                    onChange={(e) => {
                      const next = [...lines];
                      next[idx] = { ...next[idx], sku: e.target.value };
                      setLines(next);
                    }}
                  />
                  <input
                    className="col-span-4 rounded-md border px-3 py-2"
                    type="number"
                    placeholder="수량"
                    value={line.orderedQty}
                    onChange={(e) => {
                      const next = [...lines];
                      next[idx] = { ...next[idx], orderedQty: Number(e.target.value) };
                      setLines(next);
                    }}
                  />
                  <button
                    type="button"
                    className="col-span-1 rounded-md border px-2 py-2 text-xs"
                    onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                    aria-label="행 삭제"
                  >
                    삭제
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm"
                onClick={() => setLines((prev) => [...prev, { sku: '', orderedQty: 0 }])}
              >
                + 라인 추가
              </button>
            </div>
          </div>

          {formError && <p className="text-sm text-rose-600">{formError}</p>}

          <div className="flex justify-end gap-2">
            <button type="button" className="rounded-md border px-4 py-2" onClick={() => setCreateOpen(false)}>
              취소
            </button>
            <button
              type="submit"
              disabled={creating}
              className="rounded-md bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {creating ? '저장 중…' : '저장'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default SalesPage;
