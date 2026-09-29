import type { RouteRecordRaw } from 'vue-router';
import { RouteName } from '../names';

const _group = () => import('@/views/Group');

export const teacherRoutes: RouteRecordRaw[] = [
  {
    path: '/teacher/groups/:groupId(\\d+)',
    name: RouteName.GROUP,
    component: _group,
    meta: { permissions: ['TEACHER'], title: 'Группа' },
    children: [
      { path: 'grades', name: RouteName.GROUP_GRADES, component: () => import('@/components/GradesTab.vue') },
    ],
  },
];
