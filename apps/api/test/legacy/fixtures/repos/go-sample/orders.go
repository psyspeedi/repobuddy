package sample

type Order struct {
	ID         string
	Total      float64
	CustomerID string
}

type OrderRepository struct {
	orders map[string]Order
}

func NewOrderRepository() *OrderRepository {
	return &OrderRepository{orders: make(map[string]Order)}
}

func (r *OrderRepository) Save(o Order) {
	r.orders[o.ID] = o
}

func (r *OrderRepository) Find(id string) (Order, bool) {
	o, ok := r.orders[id]
	return o, ok
}

type OrderService struct {
	repo *OrderRepository
}

func NewOrderService(repo *OrderRepository) *OrderService {
	return &OrderService{repo: repo}
}

func (s *OrderService) Create(total float64, customerID string) Order {
	order := Order{ID: "stub-uuid", Total: total, CustomerID: customerID}
	s.repo.Save(order)
	LogEvent("order.created", map[string]any{"order_id": order.ID})
	return order
}

func (s *OrderService) ProcessPayment(orderID string) bool {
	order, ok := s.repo.Find(orderID)
	if !ok {
		return false
	}
	LogEvent("payment.processed", map[string]any{"order_id": orderID, "amount": order.Total})
	return true
}
