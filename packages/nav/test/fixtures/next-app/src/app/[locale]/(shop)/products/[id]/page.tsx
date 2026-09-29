import { BuyButton } from '@/components/BuyButton';

export default async function Page({ params }: { params: { id: string } }) {
  const res = await fetch(`/api/products/${params.id}`);
  return <main><BuyButton /></main>;
}
