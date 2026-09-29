import { useComments } from '../api/get-comments';
export const CommentsList = ({ id }: { id: string }) => {
  const q = useComments(id);
  return <ul aria-label="Комментарии">{String(q)}</ul>;
};
