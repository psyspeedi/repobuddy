import { NgModule } from '@angular/core';
import { OrdersRoutingModule } from './orders-routing.module';
import { OrdersListComponent } from './orders-list/orders-list.component';
import { OrderRowComponent } from './order-row/order-row.component';

@NgModule({ imports: [OrdersRoutingModule], declarations: [OrdersListComponent, OrderRowComponent] })
export class OrdersModule {}
