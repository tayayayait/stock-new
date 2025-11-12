import React, { useRef, useState } from 'react';
import Modal from '../../../../../components/ui/Modal';
import { importShipmentsFromCsv, type ImportShipmentsResult } from '../../../../services/orders';

interface ImportShipmentsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImported?: (result: ImportShipmentsResult) => void;
}

export const SHIPMENTS_TEMPLATE_URL = '/templates/shipments_template.csv';
const ERROR_DISPLAY_LIMIT = 5;

const readFileAsText = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () =>
      reject(reader.error ?? new Error('CSV 파일을 읽는 중 오류가 발생했습니다.'));
    reader.readAsText(file, 'utf-8');
  });
};

const ImportShipmentsModal: React.FC<ImportShipmentsModalProps> = ({ isOpen, onClose, onImported }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [csvText, setCsvText] = useState('');
  const [result, setResult] = useState<ImportShipmentsResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const resetState = () => {
    setCsvText('');
    setResult(null);
    setIsSubmitting(false);
    setSelectedFile(null);
    setFileError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const handleSelectFile = async (file: File | null) => {
    setFileError(null);
    if (!file) {
      setSelectedFile(null);
      setCsvText('');
      return;
    }

    try {
      const text = await readFileAsText(file);
      setSelectedFile(file);
      setCsvText(text);
      setResult(null);
    } catch (error) {
      console.error(error);
      setSelectedFile(null);
      setCsvText('');
      setFileError(error instanceof Error ? error.message : 'CSV 파일을 불러오지 못했습니다.');
    }
  };

  const handleTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setCsvText(event.target.value);
    setResult(null);
    if (selectedFile) {
      setSelectedFile(null);
    }
  };

  const handleFileInputClick = () => {
    fileInputRef.current?.click();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFileError(null);
    if (isSubmitting) {
      return;
    }
    if (!csvText.trim()) {
      setFileError('CSV 파일을 선택하거나 데이터를 입력해 주세요.');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await importShipmentsFromCsv(csvText);
      setResult(response);
      setCsvText('');
      onImported?.(response);
    } catch (error) {
      console.error(error);
      setResult({ addedOrders: 0, addedLines: 0, errors: ['CSV 업로드 중 오류가 발생했습니다.'] });
    } finally {
      setIsSubmitting(false);
    }
  };

  const errorsToDisplay = result ? result.errors.slice(0, ERROR_DISPLAY_LIMIT) : [];
  const hiddenErrorCount = result ? Math.max(0, result.errors.length - ERROR_DISPLAY_LIMIT) : 0;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="출고 CSV 업로드" widthClassName="max-w-3xl">
      <form onSubmit={handleSubmit} className="space-y-6">
        <section className="space-y-3 text-sm text-slate-600">
          <p className="text-slate-500">
            발생일시 · 카테고리 · SKU(품번) · 출고량은 필수이며, 거래처명 또는 거래처ID 중 하나는 채워주세요. 품명은 선택이지만 채워두면 Top/Worst SKU 표에 즉시 반영됩니다. 날짜는 KST 기준으로 집계됩니다.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">
            <li>전월 · 전년 동월 데이터를 함께 넣으면 MoM/YoY 선이 활성화됩니다.</li>
            <li>category 값이 카테고리 Top5 · Worst5에 바로 반영됩니다.</li>
            <li>품명을 채우면 이달 Top5/Worst5 SKU 표에 그대로 표시됩니다.</li>
            <li>partnerId가 없으면 partnerName으로 샘플 고객을 매칭합니다.</li>
            <li>CSV는 로컬 메모리용 모의 데이터이므로 새로고침 시 초기화됩니다.</li>
          </ul>
          <div className="text-xs text-slate-500">
            템플릿:{' '}
            <a className="font-semibold text-primary-600 hover:underline" href={SHIPMENTS_TEMPLATE_URL} download>
              shipments_template.csv
            </a>
          </div>
        </section>

        <section className="space-y-3">
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                void handleSelectFile(file);
                event.target.value = '';
              }}
            />
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-medium text-slate-700">
                  {selectedFile ? selectedFile.name : '선택된 파일이 없습니다.'}
                </p>
                <p className="text-xs text-slate-500">CSV 형식, UTF-8 인코딩. 헤더 행이 포함되어야 합니다.</p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleFileInputClick}
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:border-primary-300 hover:text-primary-600"
                >
                  파일 선택
                </button>
                {selectedFile && (
                  <button
                    type="button"
                    onClick={() => void handleSelectFile(selectedFile)}
                    className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:border-primary-300 hover:text-primary-600"
                  >
                    다시 불러오기
                  </button>
                )}
              </div>
            </div>
          </div>
          <p className="text-xs text-slate-500">또는 아래 입력란에 CSV를 붙여넣을 수 있습니다.</p>
          <label className="block text-sm font-medium text-slate-700">
            CSV 데이터
            <textarea
              value={csvText}
              onChange={handleTextareaChange}
              rows={10}
              placeholder="발생일시,거래처명,SKU(품번),품명,카테고리,출고량"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-primary-500 focus:outline-none focus:ring-primary-500"
            />
          </label>
          {fileError && (
            <p className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-600">{fileError}</p>
          )}
        </section>

        {result && (
          <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold text-slate-900">적용 결과</span>
              <span className="text-xs text-slate-500">주문 {result.addedOrders}건 · 라인 {result.addedLines}행</span>
            </div>
            {result.errors.length === 0 ? (
              <p className="text-emerald-600">오류 없이 업로드되었습니다.</p>
            ) : (
              <div className="space-y-2">
                <p className="text-rose-600">일부 행은 무시되었습니다.</p>
                <ul className="list-disc space-y-1 pl-4 text-xs text-rose-600">
                  {errorsToDisplay.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                  {hiddenErrorCount > 0 && <li>외 {hiddenErrorCount}건</li>}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <a
            href={SHIPMENTS_TEMPLATE_URL}
            download
            className="rounded-md border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
          >
            템플릿 다운로드
          </a>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            >
              닫기
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !csvText.trim()}
              className={`rounded-md px-4 py-2 text-sm font-semibold text-white ${
                isSubmitting || !csvText.trim()
                  ? 'bg-primary-300'
                  : 'bg-primary-600 hover:bg-primary-700'
              }`}
            >
              {isSubmitting ? '적용 중...' : 'CSV 적용'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
};

export default ImportShipmentsModal;
