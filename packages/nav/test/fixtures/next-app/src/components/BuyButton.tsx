import { useTranslations } from 'next-intl';

export function BuyButton() {
  const t = useTranslations('Product');
  return <button>{t('buy')}</button>;
}
