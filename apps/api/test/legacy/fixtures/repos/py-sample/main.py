from orders import OrderRepository, OrderService


def main() -> None:
    repo = OrderRepository()
    service = OrderService(repo)
    order = service.create(total=100.0, customer_id="cust-1")
    service.process_payment(order.id)


if __name__ == "__main__":
    main()
