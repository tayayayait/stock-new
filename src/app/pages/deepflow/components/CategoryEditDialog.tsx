import React, { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { type Category } from '../../../../services/categories';
import { useCategoryStore } from '../stores/categoryStore';

interface CategoryEditDialogProps {
  open: boolean;
  category: Category;
  onClose: () => void;
  onCompleted?: (category: Category) => void;
}

const inputClassName =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500';

const labelClassName = 'text-xs font-semibold uppercase tracking-wide text-slate-600';

interface EditableChild {
  id: string;
  name: string;
  originalName: string;
  parentId: string | null;
  isNew: boolean;
}

const CategoryEditDialog: React.FC<CategoryEditDialogProps> = ({ open, category, onClose, onCompleted }) => {
  const { update, create, saving, error, clearError } = useCategoryStore();

  const [name, setName] = useState(category.name);
  const [childEntries, setChildEntries] = useState<EditableChild[]>(
    category.children.map((child) => ({
      id: child.id,
      name: child.name,
      originalName: child.name,
      parentId: child.parentId ?? category.id ?? null,
      isNew: false,
    })),
  );
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName(category.name);
    setChildEntries(
      category.children.map((child) => ({
        id: child.id,
        name: child.name,
        originalName: child.name,
        parentId: child.parentId ?? category.id ?? null,
        isNew: false,
      })),
    );
    setFormError(null);
    clearError();
  }, [category.children, category.id, category.name, clearError, open]);

  const handleClose = useCallback(() => {
    if (saving) {
      return;
    }
    onClose();
  }, [onClose, saving]);

  const handleChildChange = useCallback((childId: string, value: string) => {
    setChildEntries((prev) =>
      prev.map((entry) => (entry.id === childId ? { ...entry, name: value } : entry)),
    );
    setFormError(null);
  }, []);

  const handleAddChild = useCallback(() => {
    if (saving) {
      return;
    }
    const generatedId = `__new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setChildEntries((prev) => [
      ...prev,
      {
        id: generatedId,
        name: '',
        originalName: '',
        parentId: category.id ?? null,
        isNew: true,
      },
    ]);
    setFormError(null);
  }, [category.id, saving]);

  const handleRemoveChild = useCallback((childId: string) => {
    if (saving) {
      return;
    }
    setChildEntries((prev) => prev.filter((entry) => entry.id !== childId));
    setFormError(null);
  }, [saving]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedName = name.trim();
      if (!trimmedName) {
        setFormError('카테고리 이름을 입력해주세요.');
        return;
      }

      const normalizedChildren = childEntries.map((entry) => {
        const trimmedChildName = entry.name.trim();
        const normalizedParentId =
          typeof entry.parentId === 'string' && entry.parentId.trim().length > 0
            ? entry.parentId.trim()
            : category.id ?? null;
        return {
          ...entry,
          parentId: normalizedParentId,
          trimmedName: trimmedChildName,
        };
      });

      if (normalizedChildren.some((entry) => entry.trimmedName.length === 0)) {
        setFormError('하위 카테고리 이름을 입력해주세요.');
        return;
      }

      if (normalizedChildren.some((entry) => entry.isNew && !entry.parentId)) {
        setFormError('하위 카테고리를 추가할 상위 분류를 찾을 수 없습니다.');
        return;
      }

      const duplicateTracker = new Set<string>();
      for (const entry of normalizedChildren) {
        const parentBucket = entry.parentId ?? category.id ?? 'root';
        const key = `${parentBucket}::${entry.trimmedName.toLowerCase()}`;
        if (duplicateTracker.has(key)) {
          setFormError('하위 카테고리 이름이 중복됩니다.');
          return;
        }
        duplicateTracker.add(key);
      }

      try {
        setFormError(null);

        let latestParent: Category = category;

        if (trimmedName !== category.name) {
          latestParent = await update(category.id, {
            name: trimmedName,
            parentId: category.parentId,
          });
        }

        const existingChildrenToUpdate = normalizedChildren.filter(
          (entry) => !entry.isNew && entry.trimmedName !== entry.originalName,
        );
        const createdChildrenCandidates = normalizedChildren.filter((entry) => entry.isNew);

        const updatedChildrenMap = new Map<string, Category>();
        for (const entry of existingChildrenToUpdate) {
          const updatedChild = await update(entry.id, {
            name: entry.trimmedName,
            parentId: entry.parentId ?? latestParent.id ?? null,
          });
          updatedChildrenMap.set(entry.id, updatedChild);
        }

        const createdChildren: Category[] = [];
        for (const entry of createdChildrenCandidates) {
          const parentId = entry.parentId ?? latestParent.id ?? null;
          if (!parentId) {
            setFormError('하위 카테고리를 추가할 상위 분류를 찾을 수 없습니다.');
            return;
          }
          const createdChild = await create({
            name: entry.trimmedName,
            parentId,
          });
          createdChildren.push(createdChild);
        }

        const baseChildren = (latestParent.children ?? category.children).map((child) => {
          const updatedChild = updatedChildrenMap.get(child.id);
          return updatedChild ? { ...child, name: updatedChild.name } : child;
        });

        const mergedChildren = [...baseChildren, ...createdChildren];

        const resolvedCategory = {
          ...latestParent,
          name: trimmedName,
          children: mergedChildren,
        };

        onCompleted?.(resolvedCategory);
        onClose();
      } catch (submitError) {
        if (submitError instanceof Error && submitError.message) {
          setFormError(submitError.message);
        } else {
          setFormError('카테고리를 수정하지 못했습니다.');
        }
      }
    },
    [category, childEntries, create, name, onClose, onCompleted, update],
  );

  const activeError = useMemo(() => formError ?? error ?? null, [error, formError]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="category-edit-dialog-title"
        className="w-full max-w-lg rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 id="category-edit-dialog-title" className="text-lg font-semibold text-slate-800">
            카테고리 수정
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full border border-slate-200 px-2 py-1 text-sm text-slate-500 hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={saving}
          >
            닫기
          </button>
        </div>

        <form className="space-y-5 px-5 py-6 text-sm text-slate-700" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-2">
            <span className={labelClassName}>카테고리 이름</span>
            <input
              type="text"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setFormError(null);
              }}
              className={inputClassName}
              placeholder="예: 식품"
              autoFocus
            />
          </label>

          <div className="flex flex-col gap-3">
            <span className={labelClassName}>하위 카테고리</span>
            {childEntries.length === 0 ? (
              <p className="text-xs text-slate-500">등록된 하위 카테고리가 없습니다. 필요한 경우 아래 버튼으로 추가하세요.</p>
            ) : null}
            {childEntries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-2">
                <input
                  type="text"
                  value={entry.name}
                  onChange={(event) => handleChildChange(entry.id, event.target.value)}
                  className={inputClassName}
                  placeholder="하위 카테고리 이름"
                />
                {entry.isNew ? (
                  <button
                    type="button"
                    onClick={() => handleRemoveChild(entry.id)}
                    className="rounded-md border border-slate-200 px-2 py-2 text-xs font-semibold text-slate-500 transition hover:border-red-300 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={saving}
                  >
                    제거
                  </button>
                ) : null}
              </div>
            ))}
            <div>
              <button
                type="button"
                onClick={handleAddChild}
                className="rounded-md border border-dashed border-indigo-300 px-3 py-2 text-xs font-semibold text-indigo-600 transition hover:border-indigo-400 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={saving}
              >
                + 하위 카테고리 추가
              </button>
            </div>
          </div>

          {activeError && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{activeError}</p>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={saving}
            >
              취소
            </button>
            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
              disabled={saving}
            >
              저장
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CategoryEditDialog;
