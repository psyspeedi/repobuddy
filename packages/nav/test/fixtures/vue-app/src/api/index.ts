import axios from 'axios';
import groups from './modules/groups';
const client = axios.create({ baseURL: '/api' });
export const api = { modules: { v3: { teacher: { groups: groups(client) } } } };
