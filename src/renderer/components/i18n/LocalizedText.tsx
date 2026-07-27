import { useTranslation } from 'react-i18next'
import type { I18nNamespace } from '../../../shared/i18n/types'
import { INSPECT_KEY_ATTRIBUTE, isInspecting } from './inspectMode'

interface LocalizedTextProps {
  ns: I18nNamespace
  i18nKey: string
}

export default function LocalizedText({ ns, i18nKey }: LocalizedTextProps) {
  const { t } = useTranslation(ns)

  // `display: contents` keeps the wrapper out of layout entirely, so inspect mode cannot change
  // how anything renders — a bare <span> would become a flex or grid item and quietly shift the
  // very UI being inspected. The inspector measures the text with a Range instead, since an
  // element with `display: contents` generates no box of its own.
  if (isInspecting) {
    return (
      <span style={{ display: 'contents' }} {...{ [INSPECT_KEY_ATTRIBUTE]: `${ns}:${i18nKey}` }}>
        {t(i18nKey)}
      </span>
    )
  }

  return <>{t(i18nKey)}</>
}

