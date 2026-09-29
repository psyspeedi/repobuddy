import VueRouter from 'vue-router/vite';
import Layouts from 'vite-plugin-vue-layouts';
export default { plugins: [VueRouter({ extensions: ['.vue', '.md'] }), Layouts()] };
