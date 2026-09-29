import { RouteName } from '../names';
import { teacherRoutes } from './teacher';

export default [
  { path: '/', name: RouteName.HOME, component: () => import('@/views/Home.vue') },
  ...teacherRoutes,
];
