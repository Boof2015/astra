import { useTranslation } from 'react-i18next'
import type { I18nNamespace } from '../../../shared/i18n/types'

interface LocalizedTextProps {
  ns: I18nNamespace
  i18nKey: string
}

export default function LocalizedText({ ns, i18nKey }: LocalizedTextProps) {
  const { t } = useTranslation(ns)
  return <>{t(i18nKey)}</>
}

