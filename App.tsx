import * as React from 'react';
import { NavLink, Outlet } from 'react-router-dom';

import ToastProvider from './src/components/Toaster';

const AppLayout: React.FC = () => {
  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-col bg-slate-100">
        <header className="border-b border-slate-200 bg-white print:hidden">
          <div className="flex w-full items-center justify-between px-6 py-4">
            <h1 className="text-lg font-semibold text-slate-800">STOCK- Console</h1>
            <nav className="flex items-center gap-2 text-sm">
              <NavLink
                to="/"
                end
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 font-semibold transition ${
                    isActive ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
                  }`
                }
              >
                수요/재고 대시보드
              </NavLink>
              <NavLink
                to="/orders"
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 font-semibold transition ${
                    isActive ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
                  }`
                }
              >
                주문서 관리
              </NavLink>
            </nav>
          </div>
        </header>
        <main className="flex-1 px-6 py-6">
          <Outlet />
        </main>
      </div>
    </ToastProvider>
  );
};

export default AppLayout;
