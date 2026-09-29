import { createBrowserRouter } from 'react-router-dom';
import { paths } from '@/config/paths';

export const createAppRouter = () =>
  createBrowserRouter([
    {
      path: paths.app.root.path,
      children: [
        {
          path: paths.app.discussion.path,
          lazy: () => import('./discussion'),
        },
      ],
    },
  ]);
