export const load = async ({ fetch, params }) => {
  const user = await fetch(`/api/users/${params.id}`).then((r) => r.json());
  return { user };
};
