import { createApp } from 'vue';
import App from './App.vue';
import MButton from '@/components/MButton.vue';
import router from './router';
const app = createApp(App);
app.component('MButton', MButton);
app.use(router).mount('#app');
