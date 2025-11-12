import * as React from 'react';
import { createBrowserRouter } from 'react-router-dom';
import App from '../../App';
import DeepflowDashboard from './pages/deepflow/DeepflowDashboard';
import OrdersPage from '@/src/domains/orders/pages/OrdersPage';
import NewPurchaseOrderPage from './pages/purchase-orders/NewPurchaseOrderPage';
import PurchaseOrderDetailPage from './pages/purchase-orders/PurchaseOrderDetailPage';
import SmartWarehouseLayout from './layout/SmartWarehouseLayout';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        path: '',
        element: <SmartWarehouseLayout />,
        children: [
          {
            index: true,
            element: <DeepflowDashboard />,
          },
          {
            path: 'purchase-orders/new',
            element: <NewPurchaseOrderPage />,
          },
          {
            path: 'purchase-orders/:id',
            element: <PurchaseOrderDetailPage />,
          },
        ],
      },
      {
        path: 'orders',
        element: <OrdersPage />,
      },
    ],
  },
]);
