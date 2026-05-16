from dataclasses import dataclass
from telemetry import log_event


@dataclass
class Order:
    id: str
    total: float
    customer_id: str


class OrderRepository:
    def __init__(self) -> None:
        self._orders: dict[str, Order] = {}

    def save(self, order: Order) -> None:
        self._orders[order.id] = order

    def find(self, order_id: str) -> Order | None:
        return self._orders.get(order_id)


class OrderService:
    def __init__(self, repo: OrderRepository) -> None:
        self.repo = repo

    def create(self, total: float, customer_id: str) -> Order:
        import uuid
        order = Order(id=str(uuid.uuid4()), total=total, customer_id=customer_id)
        self.repo.save(order)
        log_event("order.created", {"order_id": order.id})
        return order

    def process_payment(self, order_id: str) -> bool:
        order = self.repo.find(order_id)
        if not order:
            return False
        log_event("payment.processed", {"order_id": order_id, "amount": order.total})
        return True
