import { useTranslation } from 'react-i18next'
import { SessionManagement as SessionManagementComponent } from '@/components/proxy'
import { ContextManagement } from '@/components/proxy/ContextManagement'

export function SessionManagement() {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{t('session.title')}</h2>
        <p className="text-muted-foreground">{t('session.description')}</p>
      </div>

      <SessionManagementComponent />
      <ContextManagement />
    </div>
  )
}

export default SessionManagement
