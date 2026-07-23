import { cloneElement, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

interface LocaleRerenderBoundaryProps {
  children: ReactElement
}

export default function LocaleRerenderBoundary({ children }: LocaleRerenderBoundaryProps) {
  const { i18n } = useTranslation()
  return cloneElement(children, {
    'data-locale-revision': i18n.resolvedLanguage ?? i18n.language,
  } as Record<string, unknown>)
}

