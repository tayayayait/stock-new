import React, { useCallback, useEffect, useState } from 'react';
import { Outlet, useNavigate, useSearchParams } from 'react-router-dom';

export const DASHBOARD_TABS = [
  'inventory',
  'forecast',
  'products',
  'categories',
  'warehouses',
  'partners',
  'purchase',
  'sales',
  'policies',
  'policyOps',
] as const;

export type DashboardTab = (typeof DASHBOARD_TABS)[number];

const DASHBOARD_TAB_SET = new Set<string>(DASHBOARD_TABS);

export const isDashboardTab = (value: string | null): value is DashboardTab =>
  value !== null && DASHBOARD_TAB_SET.has(value);

export const DEFAULT_DASHBOARD_TAB: DashboardTab = 'inventory';

export type SmartWarehouseOutletContext = {
  active: DashboardTab;
};

const NavItem: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({
  label,
  active,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`w-full rounded-2xl px-4 py-2 text-left text-sm font-medium transition-colors duration-150 ${
      active
        ? 'bg-indigo-500/90 text-white shadow-sm ring-1 ring-indigo-300/70'
        : 'text-indigo-950/70 hover:bg-indigo-200/40 hover:text-indigo-800'
    }`}
  >
    {label}
  </button>
);

const SmartWarehouseLayout: React.FC = () => {
  const [currentSearchParams] = useSearchParams();
  const tabParam = currentSearchParams.get('tab');
  const navigate = useNavigate();
  const active: DashboardTab = isDashboardTab(tabParam) ? tabParam : DEFAULT_DASHBOARD_TAB;
  const [purchaseSalesOpen, setPurchaseSalesOpen] = useState(
    active === 'purchase' || active === 'sales',
  );

  useEffect(() => {
    if (active === 'purchase' || active === 'sales') {
      setPurchaseSalesOpen(true);
    }
  }, [active]);

  const switchTab = useCallback(
    (nextTab: DashboardTab) => {
      const params = new URLSearchParams();
      params.set('tab', nextTab);
      const encoded = params.toString();
      navigate({
        pathname: '/',
        search: encoded ? `?${encoded}` : undefined,
      });
    },
    [navigate],
  );

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-indigo-100 via-white to-sky-100 text-slate-900 print:bg-white print:min-h-0 print:h-auto print:p-0 print:px-0 print:py-0">
      <div className="flex min-h-screen w-full flex-col px-4 py-10 sm:px-6 lg:px-10 xl:px-12 print:min-h-0 print:h-auto print:p-0 print:px-0 print:py-0">
        <div className="flex flex-1 gap-6 rounded-[32px] bg-white/40 p-6 shadow-[0_30px_80px_-40px_rgba(15,23,42,0.65)] backdrop-blur-2xl ring-1 ring-white/60 print:bg-transparent print:shadow-none print:ring-0 print:p-0 print:gap-0 print:rounded-none">
          <aside className="flex w-72 flex-col rounded-3xl bg-white/70 p-6 text-sm shadow-xl ring-1 ring-white/70 backdrop-blur-xl print:hidden">
            <div className="mb-6 text-lg font-semibold text-indigo-950/80">스마트창고</div>
            <nav className="flex-1 space-y-2">
              <NavItem label="수요예측" active={active === 'forecast'} onClick={() => switchTab('forecast')} />
              <NavItem label="재고관리" active={active === 'inventory'} onClick={() => switchTab('inventory')} />
              <NavItem label="품목관리" active={active === 'products'} onClick={() => switchTab('products')} />
              <NavItem label="카테고리 수정" active={active === 'categories'} onClick={() => switchTab('categories')} />
              <NavItem label="창고관리" active={active === 'warehouses'} onClick={() => switchTab('warehouses')} />
              <NavItem label="거래처관리" active={active === 'partners'} onClick={() => switchTab('partners')} />
              <button
                type="button"
                aria-expanded={purchaseSalesOpen}
                onClick={() => setPurchaseSalesOpen((value) => !value)}
                className={`w-full rounded-2xl px-4 py-2 text-left text-sm font-medium transition-colors duration-150 flex items-center justify-between ${
                  active === 'purchase' || active === 'sales'
                    ? 'bg-indigo-500/90 text-white shadow-sm ring-1 ring-indigo-300/70'
                    : 'text-indigo-950/70 hover:bg-indigo-200/40 hover:text-indigo-800'
                }`}
              >
                <span>구매 및 판매</span>
                <svg
                  className={`h-4 w-4 transition-transform ${purchaseSalesOpen ? 'rotate-180' : 'rotate-0'}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <div className={`overflow-hidden transition-[max-height] duration-200 ${purchaseSalesOpen ? 'max-h-32' : 'max-h-0'}`}>
                <div className="mt-1 space-y-1 pl-3">
                  <NavItem label="구매" active={active === 'purchase'} onClick={() => switchTab('purchase')} />
                  <NavItem label="판매" active={active === 'sales'} onClick={() => switchTab('sales')} />
                </div>
              </div>
              <NavItem label="예측기준관리" active={active === 'policies'} onClick={() => switchTab('policies')} />
              <NavItem label="운영 지표" active={active === 'policyOps'} onClick={() => switchTab('policyOps')} />
            </nav>
          </aside>
          <main className="flex flex-1 flex-col overflow-hidden rounded-[28px] bg-white/70 shadow-xl ring-1 ring-white/70 backdrop-blur-xl print:bg-transparent print:shadow-none print:ring-0 print:rounded-none print:overflow-visible">
            <div className="flex-1 overflow-y-auto px-8 pb-10 print:overflow-visible print:px-0 print:pb-0">
              <Outlet context={{ active }} />
            </div>
          </main>
        </div>
      </div>
    </div>
  );
};

export default SmartWarehouseLayout;
