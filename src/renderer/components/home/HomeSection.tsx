import { useId, type ReactNode } from 'react'

export default function HomeSection({ id, title, detail, actions, axis = 'grid', children }: {
  id: string
  title: string
  detail?: string
  actions?: ReactNode
  axis?: 'grid' | 'horizontal'
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section className="home-dashboard-section" aria-labelledby={headingId} data-controller-group={`home-${id}`} data-controller-axis={axis}>
      <div className="home-dashboard-section-header">
        <div><h2 id={headingId}>{title}</h2>{detail && <span className="home-section-detail">{detail}</span>}</div>
        {actions && <div className="home-dashboard-section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  )
}
