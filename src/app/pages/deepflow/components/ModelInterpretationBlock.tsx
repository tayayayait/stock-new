import * as React from 'react';
import type { ForecastExplanation, ForecastInsight } from '../../../../services/api';

interface ModelInterpretationBlockProps {
  insight: ForecastInsight | null;
  fallback: ForecastExplanation | null;
  loading?: boolean;
  error?: string | null;
  notice?: string | null;
}

const ModelInterpretationBlock: React.FC<ModelInterpretationBlockProps> = ({
  insight,
  fallback,
  loading = false,
  error = null,
  notice = null,
}) => {
  if (loading) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-sm">
        <h4 className="text-sm font-semibold text-slate-700">모델 해석</h4>
        <p className="mt-3 text-xs text-slate-500">예측 결과 해석을 수집하는 중입니다...</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-2xl border border-rose-200 bg-rose-50/80 p-4 text-xs text-rose-600 shadow-sm">
        {error}
      </section>
    );
  }

  if (insight) {
    const sourceLabel = insight.source === 'llm' ? 'LLM 기반 분석' : '기본 해석';
    return (
      <section className="rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-sm">
        <header>
          <h4 className="text-sm font-semibold text-slate-700">모델 해석</h4>
          <p className="mt-1 text-xs text-slate-500">{sourceLabel}</p>
        </header>
        <p className="mt-3 text-xs leading-5 text-slate-600">{insight.summary}</p>
        {insight.risks?.length ? (
          <div className="mt-4">
            <h5 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Upside / Downside Risk</h5>
            <ul className="mt-2 space-y-2 text-xs">
              {insight.risks.map((risk) => (
                <li
                  key={risk.id}
                  className={`rounded-2xl border px-3 py-2 ${
                    risk.side === 'downside'
                      ? 'border-rose-200 bg-rose-50/80 text-rose-700'
                      : 'border-emerald-200 bg-emerald-50/80 text-emerald-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] font-semibold">
                    <span>{risk.side === 'downside' ? 'Downside' : 'Upside'} · {risk.driver}</span>
                    <span className="text-slate-500">
                      영향 {risk.impact.toUpperCase()} · 신뢰 {Math.round(risk.confidence * 100)}%
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-600">{risk.evidence}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {insight.drivers.length > 0 && (
          <div className="mt-4">
            <h5 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">주요 근거</h5>
            <ul className="mt-2 list-disc list-inside space-y-1 text-xs text-slate-600">
              {insight.drivers.map((driver, index) => (
                <li key={`driver-${index}`}>{driver}</li>
              ))}
            </ul>
          </div>
        )}
        {insight.watchouts.length > 0 && (
          <div className="mt-4">
            <h5 className="text-[11px] font-semibold uppercase tracking-wide text-amber-600">주의 사항</h5>
            <ul className="mt-2 list-disc list-inside space-y-1 text-xs text-amber-600">
              {insight.watchouts.map((item, index) => (
                <li key={`watchout-${index}`}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {notice && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-600">{notice}</p>
        )}
        {insight.rawText && (
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500">{insight.rawText}</p>
        )}
        <footer className="mt-4 border-t border-slate-100 pt-3 text-[11px] text-slate-400">
          생성 시각: {new Date(insight.generatedAt).toLocaleString('ko-KR', { hour12: false })}
        </footer>
      </section>
    );
  }

  if (!fallback) {
    return (
      <section className="rounded-2xl border border-dashed border-slate-200 bg-white/70 p-4 text-xs text-slate-500">
        머신러닝 인사이트를 표시할 데이터가 없습니다.
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-sm">
      <header>
        <h4 className="text-sm font-semibold text-slate-700">모델 해석</h4>
        <p className="mt-1 text-xs text-slate-500">{fallback.model.name}</p>
      </header>
      <p className="mt-3 text-xs leading-5 text-slate-600">{fallback.summary}</p>
      {fallback.drivers.length > 0 && (
        <ul className="mt-4 list-disc list-inside space-y-1 text-xs text-slate-600">
          {fallback.drivers.map((driver, index) => (
            <li key={index}>{driver}</li>
          ))}
        </ul>
      )}
      <footer className="mt-4 border-t border-slate-100 pt-3 text-[11px] text-slate-400">
        <div>
          학습 구간: {fallback.model.trainingWindow}
          {fallback.model.seasonalPeriod ? ` · 계절성 ${fallback.model.seasonalPeriod}` : ''}
        </div>
        <div>
          생성 시각: {new Date(fallback.model.generatedAt).toLocaleString('ko-KR', { hour12: false })}
          {typeof fallback.model.mape === 'number' ? ` · MAPE ${fallback.model.mape.toFixed(1)}%` : ''}
        </div>
      </footer>
    </section>
  );
};

export default ModelInterpretationBlock;
