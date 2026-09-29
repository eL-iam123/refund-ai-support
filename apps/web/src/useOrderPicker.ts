import { useCallback, useMemo, useState } from 'react';
import type { CustomerDto, OrderDto } from '@refund/shared';
import { api } from './api';
import { useAsyncData, type Async } from './useAsyncData';

export interface OrderPicker {
  readonly customers: Async<readonly CustomerDto[]>;
  readonly orders: Async<readonly OrderDto[]>;
  readonly customerId: string;
  readonly order: OrderDto | undefined;
  readonly selectCustomer: (next: string) => void;
  readonly selectOrder: (next: string) => void;
}

/**
 * Identity and order selection for the chat surface.
 *
 * The selection is stored as a *preference*, not as the resolved order: a
 * customer id or order id that is not in the loaded list falls back to the
 * first one instead of being trusted. That is what keeps a stale `orderId`
 * from being sent to the API after the customer switcher moves on, and it
 * removes the need to reset selection state in an effect.
 */
export function useOrderPicker(preferredOrderId = ''): OrderPicker {
  const [customerId, setCustomerId] = useState<string>('');
  const [orderId, setOrderId] = useState<string>(preferredOrderId);

  const loadCustomers = useCallback(async () => (await api.customers()).customers, []);
  const customers = useAsyncData(loadCustomers, 'customers');
  const people = useMemo(
    () => (customers.status === 'ready' ? customers.value : []),
    [customers],
  );
  const activeCustomerId = customerId.length > 0 ? customerId : (people[0]?.id ?? '');

  const loadOrders = useCallback(async () => (await api.orders(activeCustomerId)).orders, [activeCustomerId]);
  const orders = useAsyncData(loadOrders, activeCustomerId);
  const found = useMemo(
    () => (orders.status === 'ready' ? orders.value : []),
    [orders],
  );

  return {
    customers,
    orders,
    customerId: activeCustomerId,
    order: found.find((candidate) => candidate.id === orderId) ?? found[0],
    selectCustomer: setCustomerId,
    selectOrder: setOrderId,
  };
}
