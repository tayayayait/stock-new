import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  buildExistingPartnerMap,
  commitPartnerCsv,
  downloadPartnerCsvTemplate,
  parsePartnerCsv,
  type PartnerCsvCommitResult,
  type PartnerCsvPreviewResult,
} from '../../../../utils/importPartners';

interface PartnerCsvUploadDialogProps {
  open: boolean;
  onClose: () => void;
  onCompleted: () => void | Promise<void>;
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('파일을 읽는 중 오류가 발생했습니다.'));
    reader.readAsText(file, 'utf-8');
  });
}

const PartnerCsvUploadDialog: React.FC<PartnerCsvUploadDialogProps> = ({ open, onClose, onCompleted }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PartnerCsvPreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<PartnerCsvCommitResult | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedFile(null);
      setPreview(null);
      setError(null);
      setSuccessMessage(null);
      setCommitResult(null);
    }
  }, [open]);

  const handleDownloadTemplate = async () => {
    try {
      const blob = await downloadPartnerCsvTemplate();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'partner-template.csv';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'CSV 템플릿을 내려받지 못했습니다.');
    }
  };

  const handleReadFile = async (file: File) => {
    setLoading(true);
    setError(null);
    setSuccessMessage(null);
    setCommitResult(null);

    try {
      const [text, existingMap] = await Promise.all([
        readFileAsText(file),
        buildExistingPartnerMap(),
      ]);
      const previewResult = parsePartnerCsv(text, existingMap);
      setPreview(previewResult);
      setSelectedFile(file);
      if (previewResult.summary.errorCount > 0 && previewResult.rows.length === 0) {
        setError('CSV를 분석하지 못했습니다. 헤더 구성을 확인해주세요.');
      }
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'CSV를 분석하지 못했습니다.');
      setPreview(null);
      setSelectedFile(null);
    } finally {
      setLoading(false);
    }
  };

  const handleFileInputClick = () => {
    fileInputRef.current?.click();
  };

  const handleConfirm = async () => {
    if (!preview || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const result = await commitPartnerCsv(preview);
      setCommitResult(result);
      if (result.failed.length > 0) {
        setError(`총 ${result.failed.length}개의 행에서 오류가 발생했습니다.`);
      } else {
        setSuccessMessage(`신규 ${result.created}건, 수정 ${result.updated}건이 반영되었습니다.`);
        await onCompleted();
      }
      if (result.failed.length === 0) {
        setPreview(null);
        setSelectedFile(null);
      }
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : 'CSV를 반영하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const previewErrors = useMemo(() => {
    if (!preview) {
      return [];
    }
    return preview.rows.filter((row) => row.action === 'error').slice(0, 20);
  }, [preview]);

  const commitFailures = useMemo(() => {
    if (!commitResult || commitResult.failed.length === 0) {
      return [];
    }
    return commitResult.failed.slice(0, 20);
  }, [commitResult]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-800">거래처 CSV 업로드</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 px-2 py-1 text-sm text-slate-500 hover:border-slate-300 hover:text-slate-700"
          >
            닫기
          </button>
        </div>
        <div className="space-y-4 px-5 py-6 text-sm text-slate-700">
          <p className="text-slate-500">
            CSV로 거래처를 일괄 등록하거나 갱신합니다. 동일한 종류와 거래처명 조합이 존재하면 수정으로 처리됩니다.
          </p>

          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handleReadFile(file);
                }
              }}
            />
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-medium text-slate-700">{selectedFile ? selectedFile.name : '선택된 파일이 없습니다.'}</p>
                <p className="text-xs text-slate-500">
                  CSV 형식, UTF-8 인코딩. 필수 헤더: 종류, 거래처명.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleDownloadTemplate}
                  className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
                >
                  템플릿 다운로드
                </button>
                <button
                  type="button"
                  onClick={handleFileInputClick}
                  className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
                >
                  파일 선택
                </button>
                {selectedFile ? (
                  <button
                    type="button"
                    onClick={() => void handleReadFile(selectedFile)}
                    className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
                  >
                    다시 분석
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          {loading ? <p className="text-xs text-indigo-600">분석 중입니다. 잠시만 기다려 주세요...</p> : null}
          {error ? <p className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p> : null}
          {successMessage ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-600">{successMessage}</p> : null}

          {preview ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-center md:grid-cols-4">
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <p className="text-xs text-slate-400">총 행</p>
                  <p className="text-lg font-semibold text-slate-800">{preview.summary.total}</p>
                </div>
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                  <p className="text-xs text-emerald-600">신규 등록</p>
                  <p className="text-lg font-semibold text-emerald-700">{preview.summary.createCount}</p>
                </div>
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
                  <p className="text-xs text-blue-600">정보 갱신</p>
                  <p className="text-lg font-semibold text-blue-700">{preview.summary.updateCount}</p>
                </div>
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                  <p className="text-xs text-rose-600">오류 행</p>
                  <p className="text-lg font-semibold text-rose-700">{preview.summary.errorCount}</p>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="text-xs text-slate-500">
                  오류 행 {preview.summary.errorCount}개
                  {previewErrors.length > 0 && ` (상위 ${previewErrors.length}건 표시)`}
                  {preview.summary.errorCount > 0 && ' · 오류를 해결해야 업로드를 확정할 수 있습니다.'}
                </div>
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={
                    loading ||
                    preview.summary.total === 0 ||
                    preview.summary.errorCount > 0
                  }
                  className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
                >
                  업로드 확정
                </button>
              </div>

              {previewErrors.length > 0 ? (
                <div className="max-h-40 overflow-y-auto rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  <ul className="space-y-1">
                    {previewErrors.map((row) => (
                      <li key={row.rowNumber}>
                        <span className="font-semibold">행 {row.rowNumber}:</span> {row.messages.join(', ')}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          {commitFailures.length > 0 ? (
            <div className="space-y-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              <p className="font-semibold">반영 실패 행</p>
              <ul className="space-y-1">
                {commitFailures.map((failure) => (
                  <li key={failure.rowNumber}>
                    <span className="font-semibold">행 {failure.rowNumber}:</span> {failure.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default PartnerCsvUploadDialog;
