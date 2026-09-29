import { useI18n } from 'vue-i18n';
export const useGetTranslation = (prefix: string) => {
  const { t } = useI18n();
  return (key: string) => t(`${prefix}.${key}`);
};
