import type { AxiosInstance } from 'axios';
const BASE_URL = '/v3/teacher/groups';
export default (axios: AxiosInstance) => ({
  getGroup(id: number) {
    return axios.get(`${BASE_URL}/${id}`);
  },
  getGrades(id: number) {
    return axios.get(`${BASE_URL}/${id}/grades`);
  },
  saveReport: (id: number) => axios.post('/v3/teacher/reports/' + id),
});
