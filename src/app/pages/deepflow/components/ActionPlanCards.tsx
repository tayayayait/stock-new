import * as React from 'react';
import type { ActionPlanItem, ActionPlanRecord } from '../../../services/actionPlans';

interface ActionPlanCardsProps {
  plan: ActionPlanRecord | null;
  fallbackItems: ActionPlanItem[];
  loading?: boolean;
  submitting?: boolean;
  approving?: boolean;
  onSubmit?: (planId: string) => void;
  onApprove?: (planId: string) => void;
}

const statusMeta: Record<
  ActionPlanRecord['status'],
  { label: string; tone: string; description: string; nextLabel?: string }
> = {
  draft: {
    label: '초안',
    tone: 'bg-slate-100 text-slate-700 border-slate-200',
    description: 'LLM이 생성한 초안을 영업기획팀이 검토합니다.',
    nextLabel: '검토 완료',
  },
  reviewed: {
    label: '검토 완료',
    tone: 'bg-amber-50 text-amber-700 border-amber-200',
    description: '팀장이 승인하면 실행 상태가 확정됩니다.',
    nextLabel: '승인',
  },
  approved: {
    label: '승인',
    tone: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    description: '모든 액션이 승인되었습니다.',
  },
};

const formatConfidence = (value: number) => `${Math.round(value * 100)}%`;

const ActionPlanCards: React.FC<ActionPlanCardsProps> = ({
  plan,
  fallbackItems,
  loading = false,
  submitting = false,
  approving = false,
  onSubmit,
  onApprove,
}) => {
  if (loading) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-sm">
        <h4 className="text-sm font-semibold text-slate-700">실행 계획</h4>
        <p className="mt-3 text-xs text-slate-500">맞춤 실행 계획을 준비하는 중입니다...</p>
      </section>
    );
  }

  const items = plan?.items?.length ? plan.items : fallbackItems;

  if (!items.length) {
    return (
      <section className="rounded-2xl border border-dashed border-slate-200 bg-white/70 p-4 text-xs text-slate-500">
        실행 계획을 생성할 데이터가 부족합니다.
      </section>
    );
  }

  const status = plan ? statusMeta[plan.status] : null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-sm">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h4 className="text-sm font-semibold text-slate-700">실행 계획</h4>
          {status ? <p className="mt-1 text-xs text-slate-500">{status.description}</p> : null}
        </div>
        {status && (
          <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold ${status.tone}`}>
            {status.label}
            {plan?.updatedAt && <span className="font-normal text-slate-500">· {new Date(plan.updatedAt).toLocaleDateString('ko-KR')}</span>}
          </div>
        )}
      </header>
      <ul className="mt-3 space-y-3 text-xs text-slate-600">
        {items.map((item) => (
          <li key={item.id} className="rounded-2xl border border-slate-100 bg-white p-3 shadow-inner">
            <div className="flex flex-wrap gap-2 text-[11px] font-semibold text-indigo-600">
              <span className="rounded-full bg-indigo-50 px-2 py-1">{item.who}</span>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">{item.when}</span>
              <span className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-700">
                KPI: {item.kpi.name} → {item.kpi.target} ({item.kpi.window})
              </span>
              <span className="rounded-full bg-slate-50 px-2 py-1 text-slate-500">
                신뢰도 {formatConfidence(item.confidence ?? 0.5)}
              </span>
            </div>
            <p className="mt-2 text-[13px] font-semibold text-slate-900">{item.what}</p>
            {item.rationale && <p className="mt-1 leading-5 text-slate-600">{item.rationale}</p>}
          </li>
        ))}
      </ul>
      {plan && (
        <footer className="mt-4 flex flex-wrap gap-2 text-xs">
          {plan.status === 'draft' && onSubmit && (
            <button
              type="button"
              onClick={() => onSubmit(plan.id)}
              className="rounded-xl border border-indigo-200 px-3 py-1.5 font-semibold text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-60"
              disabled={submitting || approving}
            >
              {submitting ? '제출 중...' : '검토 요청'}
            </button>
          )}
          {plan.status === 'reviewed' && onApprove && (
            <button
              type="button"
              onClick={() => onApprove(plan.id)}
              className="rounded-xl border border-emerald-200 px-3 py-1.5 font-semibold text-emerald-600 transition hover:bg-emerald-50 disabled:opacity-60"
              disabled={approving}
            >
              {approving ? '승인 중...' : '승인'}
            </button>
          )}
          {!plan && (
            <p className="text-slate-500">AI 초안이 준비되는 대로 자동으로 표시됩니다.</p>
          )}
        </footer>
      )}
    </section>
  );
};

export default ActionPlanCards;
