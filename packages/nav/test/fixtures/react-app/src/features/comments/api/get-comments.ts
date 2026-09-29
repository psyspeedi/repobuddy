import { api } from '@/lib/api-client';
export const getComments = (discussionId: string) => api.get(`/comments`, { params: { discussionId } });
export const useComments = (discussionId: string) => ({ queryFn: () => getComments(discussionId) });
