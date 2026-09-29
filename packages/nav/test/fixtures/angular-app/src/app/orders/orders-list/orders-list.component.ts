import { Component } from '@angular/core';
import { OrdersService } from '../orders.service';

@Component({ selector: 'app-orders-list', templateUrl: './orders-list.component.html' })
export class OrdersListComponent {
  empty = true;
  constructor(private orders: OrdersService) {}
  load() {
    return this.orders.getAll();
  }
}
