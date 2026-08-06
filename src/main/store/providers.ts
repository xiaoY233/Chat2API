/**
 * Credential Storage Module - Provider Management API
 * Provides CRUD operations for providers
 */

import { storeManager } from './store'
import { Provider, ProviderType, AuthType, BUILTIN_PROVIDERS } from './types'

/**
 * Provider Manager Class
 * Provides all provider-related operations
 */
export class ProviderManager {
  /**
   * Get All Providers
   */
  static getAll(): Provider[] {
    return storeManager.getProviders()
  }

  /**
   * Get Provider By ID
   * @param id Provider ID
   */
  static getById(id: string): Provider | undefined {
    return storeManager.getProviderById(id)
  }

  /**
   * Get All Enabled Providers
   */
  static getEnabled(): Provider[] {
    const providers = storeManager.getProviders()
    return providers.filter((p) => p.enabled)
  }

  /**
   * Get Providers By Type
   * @param type Provider type
   */
  static getByType(type: ProviderType): Provider[] {
    const providers = storeManager.getProviders()
    return providers.filter((p) => p.type === type)
  }

  /**
   * Get Providers By Auth Type
   * @param authType Authentication type
   */
  static getByAuthType(authType: AuthType): Provider[] {
    const providers = storeManager.getProviders()
    return providers.filter((p) => p.authType === authType)
  }

  /**
   * Create Provider
   * @param data Provider data
   * @returns Created provider
   */
  static create(data: {
    name: string
    authType: AuthType
    apiEndpoint: string
    headers?: Record<string, string>
    description?: string
    icon?: string
    supportedModels?: string[]
    credentialFields?: Array<{
      name: string
      label: string
      type: 'text' | 'password' | 'textarea'
      required: boolean
      placeholder?: string
      helpText?: string
    }>
    type?: ProviderType
    id?: string
  }): Provider {
    const existing = storeManager.getProviders()
    
    // Check if provider with same ID already exists (built-in provider)
    if (data.id) {
      const existingById = existing.find(p => p.id === data.id)
      if (existingById) {
        return existingById
      }
    }
    
    // Check if provider with same name already exists
    const nameExists = existing.some(
      (p) => p.name.toLowerCase() === data.name.toLowerCase()
    )
    
    if (nameExists) {
      const existingByName = existing.find(
        (p) => p.name.toLowerCase() === data.name.toLowerCase()
      )
      if (existingByName) {
        return existingByName
      }
    }
    
    const now = Date.now()
    const provider: Provider = {
      id: data.id || storeManager.generateId(),
      name: data.name,
      type: data.type || 'custom',
      authType: data.authType,
      apiEndpoint: data.apiEndpoint,
      chatPath: data.chatPath,
      headers: data.headers || {},
      enabled: true,
      createdAt: now,
      updatedAt: now,
      description: data.description,
      icon: data.icon,
      supportedModels: data.supportedModels,
      credentialFields: data.credentialFields,
    }
    
    storeManager.addProvider(provider)
    
    storeManager.addLog('info', `Create provider: ${provider.name}`, {
      providerId: provider.id,
    })
    
    return provider
  }

  /**
   * Update Provider
   * @param id Provider ID
   * @param updates Update data
   * @returns Updated provider
   */
  static update(
    id: string,
    updates: Partial<Omit<Provider, 'id' | 'type' | 'createdAt'>>
  ): Provider | null {
    const existing = storeManager.getProviderById(id)
    
    if (!existing) {
      throw new Error(`Provider not found: ${id}`)
    }
    
    if (existing.type === 'builtin') {
      const restricted = ['name', 'authType', 'apiEndpoint']
      const hasRestricted = restricted.some((key) => key in updates)
      
      if (hasRestricted) {
        throw new Error('Built-in providers cannot modify core configuration')
      }
    }
    
    const updated = storeManager.updateProvider(id, updates)
    
    if (updated) {
      storeManager.addLog('info', `Update provider: ${existing.name}`, {
        providerId: id,
      })
    }
    
    return updated
  }

  /**
   * Delete Provider
   * @param id Provider ID
   * @returns Whether deletion was successful
   */
  static delete(id: string): boolean {
    const provider = storeManager.getProviderById(id)
    
    if (!provider) {
      return false
    }
    
    // Delete all accounts associated with the provider
    const accounts = storeManager.getAccountsByProviderId(id)
    for (const account of accounts) {
      storeManager.deleteAccount(account.id)
    }
    
    const result = storeManager.deleteProvider(id)
    
    if (result) {
      storeManager.addLog('info', `Delete provider: ${provider.name}`, {
        providerId: id,
        deletedAccounts: accounts.length,
      })
    }
    
    return result
  }

  /**
   * Enable Provider
   * @param id Provider ID
   */
  static enable(id: string): Provider | null {
    return this.update(id, { enabled: true })
  }

  /**
   * Disable Provider
   * @param id Provider ID
   */
  static disable(id: string): Provider | null {
    return this.update(id, { enabled: false })
  }

  /**
   * Check if Provider Exists
   * @param id Provider ID
   */
  static exists(id: string): boolean {
    return !!storeManager.getProviderById(id)
  }

  /**
   * Get Provider's Account Count
   * @param id Provider ID
   */
  static getAccountCount(id: string): number {
    const accounts = storeManager.getAccountsByProviderId(id)
    return accounts.length
  }

  /**
   * Get Provider's Active Account Count
   * @param id Provider ID
   */
  static getActiveAccountCount(id: string): number {
    const accounts = storeManager.getAccountsByProviderId(id)
    return accounts.filter((a) => a.status === 'active').length
  }

  /**
   * Reset Built-in Providers
   * Restore built-in providers to default configuration
   */
  static resetBuiltinProviders(): void {
    const providers = storeManager.getProviders()
    const customProviders = providers.filter((p) => p.type === 'custom')
    
    const now = Date.now()
    const defaultBuiltin: Provider[] = BUILTIN_PROVIDERS.map((p) => ({
      ...p,
      createdAt: now,
      updatedAt: now,
    }))
    
    const allProviders = [...defaultBuiltin, ...customProviders]
    storeManager.getStore()?.set('providers', allProviders)
    
    storeManager.addLog('info', 'Reset built-in provider configuration')
  }

  /**
   * Get Provider's Supported Models List
   * @param id Provider ID
   */
  static getSupportedModels(id: string): string[] {
    const provider = storeManager.getProviderById(id)
    return provider?.supportedModels || []
  }

  /**
   * Add Supported Model
   * @param id Provider ID
   * @param model Model name
   */
  static addSupportedModel(id: string, model: string): Provider | null {
    const provider = storeManager.getProviderById(id)
    
    if (!provider) {
      return null
    }
    
    const models = provider.supportedModels || []
    
    if (models.includes(model)) {
      return provider
    }
    
    return this.update(id, {
      supportedModels: [...models, model],
    })
  }

  /**
   * Remove Supported Model
   * @param id Provider ID
   * @param model Model name
   */
  static removeSupportedModel(id: string, model: string): Provider | null {
    const provider = storeManager.getProviderById(id)
    
    if (!provider) {
      return null
    }
    
    const models = provider.supportedModels || []
    const filtered = models.filter((m) => m !== model)
    
    return this.update(id, { supportedModels: filtered })
  }

  /**
   * Get Provider Statistics
   */
  static getStatistics(): {
    total: number
    builtin: number
    custom: number
    enabled: number
    disabled: number
  } {
    const providers = storeManager.getProviders()
    
    return {
      total: providers.length,
      builtin: providers.filter((p) => p.type === 'builtin').length,
      custom: providers.filter((p) => p.type === 'custom').length,
      enabled: providers.filter((p) => p.enabled).length,
      disabled: providers.filter((p) => !p.enabled).length,
    }
  }

  /**
   * Batch Update Provider Status
   * @param ids Provider ID list
   * @param enabled Whether to enable
   */
  static batchUpdateStatus(ids: string[], enabled: boolean): void {
    for (const id of ids) {
      const provider = storeManager.getProviderById(id)
      
      if (provider) {
        storeManager.updateProvider(id, { enabled })
      }
    }
    
    storeManager.addLog('info', `Batch update provider status: ${ids.length} providers`, {
      data: { ids, enabled },
    })
  }
}

export default ProviderManager
