# ts-sample

Small TypeScript fixture used by indexer tests.

## Domain

Tiny order-management example with two classes:

- `OrderRepository` — in-memory store
- `OrderService` — depends on the repository, exposes `create` and
  `processPayment` operations

The intent is to give parsers enough material to exercise imports,
class declarations, methods, and call-graph edges.
