import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { 
  Key, 
  Plus, 
  Copy, 
  Trash2, 
  Eye, 
  EyeOff,
  Shield,
  Clock,
  BarChart3,
} from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { useSettingsStore } from '@/stores/settingsStore'
import type { ApiKey } from '@/types/electron'

function generateApiKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let key = 'sk-'
  for (let i = 0; i < 48; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return key
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2)
}

export default function ApiKeysPage() {
  const { t } = useTranslation()
  const { config, updateConfig, fetchConfig } = useSettingsStore()
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set())
  const [deleteKeyId, setDeleteKeyId] = useState<string | null>(null)

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  const apiKeys = config?.apiKeys || []

  const handleToggleEnabled = async (keyId: string, enabled: boolean) => {
    const updatedKeys = apiKeys.map(k => 
      k.id === keyId ? { ...k, enabled } : k
    )
    await updateConfig({ apiKeys: updatedKeys })
    toast({
      title: enabled ? t('apiKeys.keyEnabled') : t('apiKeys.keyDisabled'),
      description: enabled ? t('apiKeys.keyEnabled') : t('apiKeys.keyDisabled'),
    })
  }

  const handleAddKey = async () => {
    if (!newKeyName.trim()) {
      toast({
        title: t('apiKeys.pleaseEnterName'),
        description: t('apiKeys.keyNameRequired'),
        variant: 'destructive',
      })
      return
    }

    const newKey: ApiKey = {
      id: generateId(),
      name: newKeyName.trim(),
      key: generateApiKey(),
      enabled: true,
      createdAt: Date.now(),
      usageCount: 0,
    }

    await updateConfig({ apiKeys: [...apiKeys, newKey] })
    setShowAddDialog(false)
    setNewKeyName('')
  }

  const handleDeleteKey = async () => {
    if (!deleteKeyId) return
    
    const updatedKeys = apiKeys.filter(k => k.id !== deleteKeyId)
    await updateConfig({ apiKeys: updatedKeys })
    setDeleteKeyId(null)
    toast({
      title: t('apiKeys.deleted'),
      description: t('apiKeys.keyDeleted'),
    })
  }

  const handleCopyKey = (key: string) => {
    navigator.clipboard.writeText(key)
    toast({
      title: t('apiKeys.copied'),
      description: t('apiKeys.copiedToClipboard'),
    })
  }

  const handleToggleVisibility = (keyId: string) => {
    const newVisible = new Set(visibleKeys)
    if (newVisible.has(keyId)) {
      newVisible.delete(keyId)
    } else {
      newVisible.add(keyId)
    }
    setVisibleKeys(newVisible)
  }

  const handleToggleGlobalEnabled = async (enabled: boolean) => {
    await updateConfig({ enableApiKey: enabled })
    toast({
      title: enabled ? t('apiKeys.authEnabled') : t('apiKeys.authDisabled'),
      description: enabled ? t('apiKeys.authEnabled') : t('apiKeys.authDisabled'),
    })
  }

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const maskKey = (key: string) => {
    if (key.length <= 10) return key
    return key.substring(0, 7) + '****' + key.substring(key.length - 4)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('apiKeys.title')}</h1>
          <p className="text-muted-foreground">{t('apiKeys.description')}</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            {t('apiKeys.apiKeyAuth')}
          </CardTitle>
          <CardDescription>
            {t('apiKeys.apiKeyAuthDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="global-enable">{t('apiKeys.enableApiKeyAuth')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('apiKeys.currentStatus')}: {config?.enableApiKey ? t('common.enabled') : t('common.disabled')}
              </p>
            </div>
            <Switch
              id="global-enable"
              checked={config?.enableApiKey || false}
              onCheckedChange={handleToggleGlobalEnabled}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Key className="h-5 w-5" />
              {t('apiKeys.apiKeyList')}
            </CardTitle>
            <CardDescription>
              {t('apiKeys.totalKeys', { count: apiKeys.length })}, {t('apiKeys.enabledKeys', { count: apiKeys.filter(k => k.enabled).length })}
            </CardDescription>
          </div>
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {t('apiKeys.newApiKey')}
          </Button>
        </CardHeader>
        <CardContent>
          {apiKeys.length === 0 ? (
            <div className="text-center py-12">
              <Key className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">{t('apiKeys.noApiKeys')}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {t('apiKeys.clickToCreate')}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('apiKeys.name')}</TableHead>
                  <TableHead>{t('apiKeys.apiKey')}</TableHead>
                  <TableHead>{t('apiKeys.status')}</TableHead>
                  <TableHead>{t('apiKeys.usageCount')}</TableHead>
                  <TableHead>{t('apiKeys.createdAt')}</TableHead>
                  <TableHead>{t('apiKeys.operations')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiKeys.map((apiKey) => (
                  <TableRow key={apiKey.id}>
                    <TableCell>
                      <div className="font-medium">{apiKey.name}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <code className="text-sm bg-muted px-2 py-1 rounded">
                          {visibleKeys.has(apiKey.id) 
                            ? apiKey.key 
                            : maskKey(apiKey.key)}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleToggleVisibility(apiKey.id)}
                        >
                          {visibleKeys.has(apiKey.id) ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleCopyKey(apiKey.key)}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={apiKey.enabled}
                        onCheckedChange={(checked) => 
                          handleToggleEnabled(apiKey.id, checked)
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <BarChart3 className="h-4 w-4 text-muted-foreground" />
                        {apiKey.usageCount}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Clock className="h-4 w-4" />
                        {formatDate(apiKey.createdAt)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => setDeleteKeyId(apiKey.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('apiKeys.createApiKey')}</DialogTitle>
            <DialogDescription>
              {t('apiKeys.createApiKeyDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="key-name">{t('apiKeys.keyName')}</Label>
              <Input
                id="key-name"
                placeholder={t('apiKeys.keyNamePlaceholder')}
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>
              {t('apiKeys.cancel')}
            </Button>
            <Button onClick={handleAddKey}>
              {t('apiKeys.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteKeyId} onOpenChange={() => setDeleteKeyId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('apiKeys.confirmDelete')}</DialogTitle>
            <DialogDescription>
              {t('apiKeys.confirmDeleteDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteKeyId(null)}>
              {t('apiKeys.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDeleteKey}>
              {t('apiKeys.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
