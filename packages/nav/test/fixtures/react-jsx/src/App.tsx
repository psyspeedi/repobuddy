import { Routes, Route } from 'react-router-dom';
import { Layout } from './Layout';
import { Settings } from './Settings';
import { RequireAuth } from './RequireAuth';

export const App = () => (
  <Routes>
    <Route path="/" element={<Layout />}>
      <Route path="settings" element={<RequireAuth><Settings /></RequireAuth>} />
    </Route>
  </Routes>
);
