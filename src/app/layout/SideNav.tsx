import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigation } from 'react-router-dom';

type NavTarget = {
  pathname: string;
  search?: string;
};

interface NavItem {
  id: string;
  label: string;
  to?: NavTarget;
  end?: boolean;
  children?: Array<{
    id: string;
    label: string;
    to: NavTarget;
  }>;
}

type NavChild = NonNullable<NavItem['children']>[number];

const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', to: { pathname: '/' }, end: true },
  { id: 'items', label: 'Items (상품)', to: { pathname: '/items' } },
  {
    id: 'purchase-sales',
    label: '구매 및 판매',
    children: [
      { id: 'purchase', label: '구매', to: { pathname: '/purchase' } },
      { id: 'sales', label: '판매', to: { pathname: '/sales' } },
    ],
  },
  { id: 'packages', label: 'Packages (출하/배송)', to: { pathname: '/packages' } },
  { id: 'reports', label: 'Reports', to: { pathname: '/reports' } },
];

const resolvePendingKey = (target: NavTarget) => target.pathname;

const buildLinkClassName = (isActive: boolean, isPending: boolean, variant: 'primary' | 'child') => {
  const base =
    'flex w-full items-center justify-between rounded-xl px-4 py-2 text-left text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-blue-200 focus:ring-offset-1';

  const variantClasses =
    variant === 'primary'
      ? isActive
        ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30'
        : 'text-slate-600 hover:bg-slate-100/80'
      : isActive
        ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
        : 'text-slate-500 hover:bg-slate-100/70';

  const pending = isPending ? 'pointer-events-none opacity-80' : '';

  return [base, variantClasses, pending].filter(Boolean).join(' ');
};

const CHEVRON_ROTATION = {
  open: 'rotate-180',
  closed: 'rotate-0',
};

const SideNav: React.FC = () => {
  const items = useMemo(() => navItems, []);
  const navigation = useNavigation();
  const pendingPath = navigation.state !== 'idle' ? navigation.location?.pathname : null;
  const location = useLocation();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') {
      return new Set();
    }
    try {
      const saved = window.localStorage.getItem('side-nav:expanded');
      if (!saved) {
        return new Set();
      }
      return new Set(JSON.parse(saved) as string[]);
    } catch {
      return new Set();
    }
  });

  const persistExpandedGroups = useCallback((groups: Set<string>) => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem('side-nav:expanded', JSON.stringify(Array.from(groups)));
    } catch {
      // Ignore storage errors
    }
  }, []);

  const doesChildMatchLocation = useCallback(
    (child: NavChild, path: string, search: string) => {
      if (path !== child.to.pathname) {
        return false;
      }
      const currentParams = new URLSearchParams(search);
      if (!child.to.search) {
        const status = currentParams.get('status');
        return !status || status === 'all';
      }
      const targetParams = new URLSearchParams(child.to.search);
      return Array.from(targetParams.entries()).every(
        ([key, value]) => currentParams.get(key) === value,
      );
    },
    [],
  );

  const isChildActive = useCallback(
    (child: NavChild) => doesChildMatchLocation(child, location.pathname, location.search),
    [doesChildMatchLocation, location.pathname, location.search],
  );

  useEffect(() => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      let changed = false;
      navItems.forEach((item) => {
        if (!item.children || item.children.length === 0) {
          return;
        }
        const shouldExpand = item.children.some((child) =>
          doesChildMatchLocation(child, location.pathname, location.search),
        );
        if (shouldExpand && !next.has(item.id)) {
          next.add(item.id);
          changed = true;
        }
      });
      if (!changed) {
        return prev;
      }
      persistExpandedGroups(next);
      return next;
    });
  }, [location.pathname, location.search, persistExpandedGroups, doesChildMatchLocation]);

  const toggleGroup = useCallback(
    (groupId: string) => {
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(groupId)) {
          next.delete(groupId);
        } else {
          next.add(groupId);
        }
        persistExpandedGroups(next);
        return next;
      });
    },
    [persistExpandedGroups],
  );

  return (
    <aside className="hidden w-64 border-r border-slate-200 bg-white/90 backdrop-blur lg:block">
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 px-4 py-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-lg font-semibold text-white">
            SW
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900">Stockwise</p>
            <p className="text-xs text-slate-500">Inventory Intelligence</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-6">
          <nav className="space-y-3">
            {items.map((item) => {
              const hasChildren = item.children && item.children.length > 0;
              if (!hasChildren && !item.to) {
                return null;
              }
              const groupPending = hasChildren
                ? item.children.some((child) => pendingPath === resolvePendingKey(child.to))
                : pendingPath === resolvePendingKey(item.to);
              const groupActive = hasChildren
                ? item.children.some((child) => isChildActive(child))
                : false;

              return (
                <div key={item.id} className="space-y-1">
                  {hasChildren ? (
                    <>
                      <button
                        type="button"
                        aria-expanded={expandedGroups.has(item.id)}
                        aria-controls={`group-${item.id}`}
                        onClick={() => toggleGroup(item.id)}
                        className={buildLinkClassName(groupActive, groupPending, 'primary')}
                      >
                        <span className="flex items-center gap-2">
                          <span>{item.label}</span>
                          {groupPending ? (
                            <span className="h-2 w-2 animate-ping rounded-full bg-white" aria-hidden="true" />
                          ) : null}
                        </span>
                        <span
                          aria-hidden="true"
                          className={`transition-transform duration-200 ${expandedGroups.has(item.id) ? CHEVRON_ROTATION.open : CHEVRON_ROTATION.closed}`}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-4 w-4 stroke-current"
                            fill="none"
                            viewBox="0 0 24 24"
                            strokeWidth={2}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                          </svg>
                        </span>
                      </button>
                      <div
                        id={`group-${item.id}`}
                        className={`overflow-hidden transition-[max-height] duration-200 ${expandedGroups.has(item.id) ? 'max-h-96' : 'max-h-0'}`}
                      >
                        <div className="space-y-1 border-l border-slate-200 pl-4">
                          {item.children.map((child) => {
                            const childPending = pendingPath === resolvePendingKey(child.to);
                            const childActive = isChildActive(child);

                            return (
                              <NavLink
                                key={child.id}
                                to={child.to}
                                className={() => buildLinkClassName(childActive, childPending, 'child')}
                                aria-disabled={childPending}
                                data-pending={childPending || undefined}
                              >
                                <span className="flex items-center gap-2 text-xs font-medium">
                                  <span>{child.label}</span>
                                  {childPending ? (
                                    <span
                                      className="h-1.5 w-1.5 animate-ping rounded-full bg-blue-400"
                                      aria-hidden="true"
                                    />
                                  ) : null}
                                  {childActive && !childPending ? (
                                    <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-tight text-blue-700">
                                      Active
                                    </span>
                                  ) : null}
                                </span>
                              </NavLink>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  ) : (
                    <NavLink
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) =>
                        buildLinkClassName(isActive, groupPending, 'primary')
                      }
                      aria-disabled={groupPending}
                      data-pending={groupPending || undefined}
                    >
                      {({ isActive }) => (
                        <>
                          <span className="flex items-center gap-2">
                            <span>{item.label}</span>
                            {groupPending ? (
                              <span className="h-2 w-2 animate-ping rounded-full bg-white" aria-hidden="true" />
                            ) : null}
                          </span>
                          {isActive && !groupPending ? (
                            <span className="text-xs font-semibold uppercase tracking-wide">Now</span>
                          ) : null}
                        </>
                      )}
                    </NavLink>
                  )}
                </div>
              );
            })}
          </nav>
        </div>
      </div>
    </aside>
  );
};

export default SideNav;
