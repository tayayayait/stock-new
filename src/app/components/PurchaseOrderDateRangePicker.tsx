import * as React from 'react';
import { KST_RANGE_PRESETS, type KstRangePreset } from '@/shared/datetime/ranges';
import { ko } from '@/src/i18n/ko';

type PresetOption = KstRangePreset | 'all';
const PRESET_OPTIONS: PresetOption[] = ['all', ...KST_RANGE_PRESETS];
const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

const toLocalDateString = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const isValidIsoDate = (value: string): value is string =>
  /^\d{4}-\d{2}-\d{2}$/.test(value);

const buildCalendarCells = (year: number, month: number) => {
  const firstOfMonth = new Date(year, month, 1);
  const firstWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  const totalCells = 6 * 7;
  for (let index = 0; index < totalCells; index += 1) {
    const dayIndex = index - firstWeekday + 1;
    let cellDate: Date;
    let isCurrentMonth = true;
    if (dayIndex <= 0) {
      cellDate = new Date(year, month, dayIndex);
      isCurrentMonth = false;
    } else if (dayIndex > daysInMonth) {
      cellDate = new Date(year, month + 1, dayIndex - daysInMonth);
      isCurrentMonth = false;
    } else {
      cellDate = new Date(year, month, dayIndex);
    }
    cells.push({ date: cellDate, isCurrentMonth });
  }
  return cells;
};

interface PurchaseOrderDateRangePickerProps {
  isOpen: boolean;
  onClose: () => void;
  onPresetSelect: (preset: KstRangePreset | 'all') => void;
  manualFrom: string;
  manualTo: string;
  onManualChange: (range: { from: string; to: string }) => void;
  onApply: () => void;
  isManualValid: boolean;
  validationMessage?: string | null;
  activePreset: KstRangePreset | 'all' | 'custom';
  maxRangeDays: number;
}

const PurchaseOrderDateRangePicker: React.FC<PurchaseOrderDateRangePickerProps> = ({
  isOpen,
  onClose,
  onPresetSelect,
  manualFrom,
  manualTo,
  onManualChange,
  onApply,
  isManualValid,
  validationMessage,
  activePreset,
  maxRangeDays,
}) => {
  const [viewDate, setViewDate] = React.useState(() => new Date());

  React.useEffect(() => {
    const anchor = manualFrom || manualTo;
    if (!anchor || !isValidIsoDate(anchor)) {
      return;
    }
    const parsed = new Date(anchor);
    if (Number.isNaN(parsed.getTime())) {
      return;
    }
    setViewDate(new Date(parsed.getFullYear(), parsed.getMonth(), 1));
  }, [manualFrom, manualTo]);

  const handleDayClick = (date: Date) => {
    const iso = toLocalDateString(date);
    const start = manualFrom;
    const end = manualTo;

    if (!start || (start && end)) {
      onManualChange({ from: iso, to: '' });
      return;
    }

    if (iso <= start) {
      onManualChange({ from: iso, to: start });
      return;
    }

    onManualChange({ from: start, to: iso });
  };

  const changeMonth = (offset: number) => {
    setViewDate((previous) => new Date(previous.getFullYear(), previous.getMonth() + offset, 1));
  };

  const cells = React.useMemo(
    () => buildCalendarCells(viewDate.getFullYear(), viewDate.getMonth()),
    [viewDate],
  );

  if (!isOpen) {
    return null;
  }

  const selectionFrom = manualFrom;
  const selectionTo = manualTo;

  const isInSelection = (value: string) => {
    if (!selectionFrom) {
      return false;
    }
    if (!selectionTo) {
      return value === selectionFrom;
    }
    return value >= selectionFrom && value <= selectionTo;
  };

  const presetButtonClass = (preset: PresetOption) =>
    [
      'rounded-2xl border px-3 py-2 text-left text-xs font-semibold transition',
      activePreset === preset
        ? 'border-indigo-600 bg-indigo-600 text-white'
        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900',
    ].join(' ');

  const rangeTitle =
    selectionFrom && selectionTo
      ? `${selectionFrom} ~ ${selectionTo}`
      : selectionFrom
        ? `${selectionFrom} ~ —`
        : ko.purchaseOrders.filter.summaryEmpty;

  return (
    <section className="rounded-3xl border border-slate-100 bg-white/95 p-6 shadow-[0_30px_60px_rgba(15,23,42,0.08)]">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-400">
            {ko.purchaseOrders.filter.label}
          </p>
          <p className="text-sm font-semibold text-slate-900">{ko.purchaseOrders.filter.title}</p>
          <p className="text-xs text-slate-500">{rangeTitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-slate-400 transition hover:text-slate-700"
          aria-label="기간 선택 닫기"
        >
          ✕
        </button>
      </div>

      <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_210px]">
        <div className="space-y-4 rounded-2xl border border-slate-100 bg-slate-50 p-5">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => changeMonth(-1)}
              className="rounded-full border border-slate-200 p-2 text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
              aria-label="이전 달"
            >
              ←
            </button>
            <p className="text-sm font-semibold text-slate-900">
              {viewDate.toLocaleString('ko-KR', {
                month: 'long',
                year: 'numeric',
              })}
            </p>
            <button
              type="button"
              onClick={() => changeMonth(1)}
              className="rounded-full border border-slate-200 p-2 text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
              aria-label="다음 달"
            >
              →
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
            {DAY_LABELS.map((label) => (
              <div key={label} className="text-center">
                {label}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {cells.map(({ date, isCurrentMonth }) => {
              const value = toLocalDateString(date);
              const inSelection = isInSelection(value);
              const isStart = value === selectionFrom;
              const isEnd = value === selectionTo;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => handleDayClick(date)}
                  className={[
                    'h-10 w-10 rounded-2xl text-sm font-semibold transition',
                    isCurrentMonth ? 'text-slate-900' : 'text-slate-300',
                    inSelection ? 'bg-indigo-600 text-white' : 'bg-white',
                    isStart ? 'rounded-l-[12px]' : '',
                    isEnd ? 'rounded-r-[12px]' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-pressed={inSelection}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>

          <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">날짜 입력</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-slate-500">
                <span className="font-semibold uppercase tracking-[0.3em]">{ko.common.start}</span>
                <input
                  type="date"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  value={manualFrom}
                  onChange={(event) =>
                    onManualChange({
                      from: event.target.value,
                      to: manualTo,
                    })
                  }
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-500">
                <span className="font-semibold uppercase tracking-[0.3em]">{ko.common.end}</span>
                <input
                  type="date"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  value={manualTo}
                  onChange={(event) =>
                    onManualChange({
                      from: manualFrom,
                      to: event.target.value,
                    })
                  }
                />
              </label>
            </div>
            {validationMessage ? (
              <p className="text-xs font-semibold text-rose-600">{validationMessage}</p>
            ) : null}
          </div>
        </div>

        <div className="space-y-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-inner">
          {PRESET_OPTIONS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={presetButtonClass(preset)}
              onClick={() => onPresetSelect(preset)}
              aria-pressed={activePreset === preset}
            >
              {preset === 'all'
                ? ko.purchaseOrders.filter.presets.all
                : ko.purchaseOrders.filter.presets[preset]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
        >
          {ko.common.cancel}
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={!isManualValid}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] transition ${
            isManualValid
              ? 'bg-indigo-600 text-white hover:bg-indigo-700'
              : 'cursor-not-allowed bg-slate-200 text-slate-400'
          }`}
        >
          {ko.common.apply}
        </button>
      </div>
    </section>
  );
};

export default PurchaseOrderDateRangePicker;
