import { useComments } from '../api/get-comments';
export const CommentsList = ({ id }: { id: string }) => {
  const q = useComments(id);
  return (
    <ul aria-label="Comments" title="Discussion comments">
      No comments yet
      {String(q)}
    </ul>
  );
};
