import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { type Category } from '../../../../services/categories';
import { useCategoryStore } from '../stores/categoryStore';
import CategoryManageDialog from './CategoryManageDialog';
import CategoryEditDialog from './CategoryEditDialog';
import ConfirmDialog from './ConfirmDialog';

type DialogState =
  | { type: 'addRoot' }
  | { type: 'edit'; category: Category }
  | { type: 'delete'; category: Category };

const normalizeText = (value: string): string => value.trim().toLowerCase();

const flattenCategoryTree = (
  categories: Category[],
  parentId: string | null = null,
): Array<{ item: Category; parentId: string | null }> => {
  const result: Array<{ item: Category; parentId: string | null }> = [];
  categories.forEach((category) => {
    result.push({ item: category, parentId });
    if (category.children.length > 0) {
      result.push(...flattenCategoryTree(category.children, category.id));
    }
  });
  return result;
};

const CategoryManagementPanel: React.FC = () => {
  const { items, loading, saving, error, load, remove, clearError } = useCategoryStore();

  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    void load().catch(() => {
      /* handled by store */
    });
  }, [load]);

  const { rowsByParent, rootLookup } = useMemo(() => {
    const map = new Map<string | null, Category[]>();
    const root = new Map<string, string>();

    const walk = (nodes: Category[], parentId: string | null, rootId: string | null) => {
      if (!map.has(parentId)) {
        map.set(parentId, []);
      }
      const bucket = map.get(parentId)!;
      nodes.forEach((node) => {
        bucket.push(node);
        const currentRootId = rootId ?? node.id;
        root.set(node.id, currentRootId);
        walk(node.children, node.id, currentRootId);
      });
    };

    walk(items, null, null);
    return { rowsByParent: map, rootLookup: root };
  }, [items]);

  const flattened = useMemo(() => flattenCategoryTree(items), [items]);

  const rootCategories = useMemo(() => rowsByParent.get(null) ?? [], [rowsByParent]);

  const visibleRootIds = useMemo(() => {
    const query = normalizeText(search);
    if (!query) {
      return new Set(rootCategories.map((category) => category.id));
    }

    const matches = new Set<string>();
    flattened.forEach(({ item }) => {
      const combined = `${item.name} ${item.description ?? ''}`.toLowerCase();
      if (combined.includes(query)) {
        const rootId = rootLookup.get(item.id) ?? item.id;
        matches.add(rootId);
      }
    });

    return matches;
  }, [flattened, rootCategories, rootLookup, search]);

  const renderRoots = useMemo(() => {
    return rootCategories.filter((category) => visibleRootIds.has(category.id));
  }, [rootCategories, visibleRootIds]);

  const handleSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(event.target.value);
  }, []);

  const handleRefresh = useCallback(() => {
    void load(search).catch(() => {
      /* handled by store */
    });
  }, [load, search]);

  const handleOpenAddRoot = useCallback(() => {
    setLocalError(null);
    setDialog({ type: 'addRoot' });
  }, []);

  const handleOpenEdit = useCallback((category: Category) => {
    setLocalError(null);
    setDialog({ type: 'edit', category });
  }, []);

  const handleOpenDelete = useCallback((category: Category) => {
    setLocalError(null);
    setDialog({ type: 'delete', category });
  }, []);

  const handleDialogClose = useCallback(() => {
    setDialog(null);
  }, []);

  const handleEntryCompleted = useCallback(() => {
    setDialog(null);
    setLocalError(null);
    void load(search).catch(() => {
      /* handled by store */
    });
  }, [load, search]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!dialog || dialog.type !== 'delete') {
      return;
    }

    try {
      await remove(dialog.category.id);
      setDialog(null);
      setLocalError(null);
    } catch (deleteError) {
      if (deleteError instanceof Error && deleteError.message) {
        setLocalError(deleteError.message);
      } else {
        setLocalError('카테고리를 삭제하지 못했습니다.');
      }
    }
  }, [dialog, remove]);

  const handleErrorDismiss = useCallback(() => {
    setLocalError(null);
    clearError();
  }, [clearError]);

  const renderEmptyState = useMemo(() => {
    if (loading && renderRoots.length === 0) {
      return '카테고리를 불러오는 중입니다...';
    }
    if (renderRoots.length === 0) {
      return '등록된 카테고리가 없습니다.';
    }
    return null;
  }, [loading, renderRoots]);

  const totalCount = useMemo(() => rootCategories.length, [rootCategories]);

  return (
    <div className="py-8">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">카테고리 관리</h1>
          <p className="mt-1 text-sm text-slate-600">카테고리 구조를 정리하고 품목 분류 체계를 유지하세요.</p>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          <label className="relative block text-xs font-semibold uppercase tracking-wide text-slate-600">
            <span className="sr-only">카테고리 검색</span>
            <input
              type="search"
              value={search}
              onChange={handleSearchChange}
              placeholder="카테고리/하위 카테고리 검색"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </label>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            새로고침
          </button>
        </div>
      </div>

      {(error || localError) && (
        <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <div className="flex items-start justify-between gap-4">
            <div className="font-medium">{localError ?? error ?? '처리 중 오류가 발생했습니다.'}</div>
            <button
              type="button"
              className="text-xs font-semibold text-red-600"
              onClick={handleErrorDismiss}
            >
              닫기
            </button>
          </div>
        </div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white/80 shadow-sm">
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">카테고리 목록</h2>
            <p className="text-xs text-slate-500">총 {totalCount}개</p>
          </div>
        </header>

        <div role="table" className="max-h-[520px] overflow-y-auto">
          <div role="rowgroup" className="min-w-full divide-y divide-slate-200">
            <div
              role="row"
              className="grid grid-cols-[minmax(200px,2fr)_minmax(160px,1.4fr)_minmax(220px,1.6fr)] bg-slate-50 px-6 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              <div>카테고리</div>
              <div>하위 카테고리</div>
              <div className="text-right">작업</div>
            </div>

            {renderEmptyState ? (
              <div role="row" className="px-6 py-10 text-center text-sm text-slate-500">
                {renderEmptyState}
              </div>
            ) : (
              renderRoots.map((row) => (
                <div
                  key={row.id}
                  role="row"
                  className="grid grid-cols-[minmax(200px,2fr)_minmax(160px,1.4fr)_minmax(220px,1.6fr)] items-center px-6 py-4 text-sm text-slate-700"
                  data-testid={`category-row-${row.id}`}
                >
                  <div className="flex flex-col gap-1">
                    <span className="font-semibold text-slate-900">{row.name || '이름 없음'}</span>
                    {(row.description ?? '').trim().length > 0 && (
                      <span className="text-xs text-slate-500">{row.description}</span>
                    )}
                  </div>

                  <div className="text-sm text-slate-600">
                    {row.children.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {row.children.map((child) => (
                          <span
                            key={child.id}
                            className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600 shadow-sm"
                          >
                            {child.name || '이름 없음'}
                          </span>
                        ))}
                      </div>
                    ) : (
                      '없음'
                    )}
                  </div>

                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => handleOpenEdit(row)}
                      className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                    >
                      수정
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenDelete(row)}
                      disabled={saving}
                      className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      삭제
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-slate-200 px-6 py-4 text-sm text-slate-600">
          <div>{saving ? '변경 사항을 저장 중입니다...' : '카테고리 구조를 정리하고 필요에 따라 분류를 추가하세요.'}</div>
          <button
            type="button"
            onClick={handleOpenAddRoot}
            className="rounded-lg border border-dashed border-indigo-300 px-4 py-2 text-sm font-semibold text-indigo-600 transition hover:border-indigo-400 hover:bg-indigo-50"
          >
            + 항목 추가
          </button>
        </footer>
      </section>

      {dialog?.type === 'addRoot' && (
        <CategoryManageDialog
          mode="category"
          open
          onClose={handleDialogClose}
          onCompleted={handleEntryCompleted}
        />
      )}

      {dialog?.type === 'edit' && (
        <CategoryEditDialog
          open
          category={dialog.category}
          onClose={handleDialogClose}
          onCompleted={handleEntryCompleted}
        />
      )}

      {dialog?.type === 'delete' && (
        <ConfirmDialog
          open
          title="카테고리 삭제"
          message={`'${dialog.category.name}' 카테고리를 삭제하시겠습니까? 하위 카테고리가 있는 경우 함께 삭제됩니다.`}
          confirmLabel="삭제"
          confirmTone="danger"
          onCancel={handleDialogClose}
          onConfirm={handleDeleteConfirm}
          confirmDisabled={saving}
        />
      )}
    </div>
  );
};

export default CategoryManagementPanel;
