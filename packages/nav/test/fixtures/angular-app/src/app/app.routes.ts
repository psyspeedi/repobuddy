import { Routes } from '@angular/router';
import { HomeComponent } from './home/home.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'orders', loadChildren: () => import('./orders/orders.module').then((m) => m.OrdersModule) },
  { path: 'profile', loadComponent: () => import('./profile/profile.component').then((m) => m.ProfileComponent) },
  { path: '**', redirectTo: '' },
];
