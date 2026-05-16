import { OrderRepository, OrderService } from './orders'

const repo = new OrderRepository()
const service = new OrderService(repo)

const order = service.create({ total: 100, customerId: 'cust-1' })
service.processPayment(order.id)
