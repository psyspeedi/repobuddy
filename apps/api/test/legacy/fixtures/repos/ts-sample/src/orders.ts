import { logEvent } from './telemetry'

export interface Order {
  id: string
  total: number
  customerId: string
}

export class OrderRepository {
  private orders = new Map<string, Order>()

  save(order: Order): void {
    this.orders.set(order.id, order)
  }

  find(id: string): Order | undefined {
    return this.orders.get(id)
  }
}

export class OrderService {
  constructor(private readonly repo: OrderRepository) {}

  create(input: Omit<Order, 'id'>): Order {
    const order: Order = { id: crypto.randomUUID(), ...input }
    this.repo.save(order)
    logEvent('order.created', { orderId: order.id })
    return order
  }

  processPayment(orderId: string): boolean {
    const order = this.repo.find(orderId)
    if (!order) return false
    logEvent('payment.processed', { orderId, amount: order.total })
    return true
  }
}
