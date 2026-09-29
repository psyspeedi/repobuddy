import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { OrdersListComponent } from './orders-list/orders-list.component';
import { OrderDetailsComponent } from './order-details.component';

@NgModule({
  imports: [
    RouterModule.forChild([
      { path: '', component: OrdersListComponent },
      { path: ':id', component: OrderDetailsComponent },
    ]),
  ],
})
export class OrdersRoutingModule {}
