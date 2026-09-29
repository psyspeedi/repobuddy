export const useCart = () => {
  const items = $fetch('/api/cart');
  return { items };
};
