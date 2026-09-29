const api = createClient();
export const loadTags = () => api.get('tags');
export const removeUser = (id: string) => api.del(`users/${id}`);
export const loadFeed = (following: boolean) => api.get('/articles' + (following ? '/feed' : ''));
export const listServers = () => (globalThis.$fetch as any)('/api/list-servers');
export const notAnApi = (m: Map<string, string>) => m.get('tags');
