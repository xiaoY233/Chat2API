import { storeManager } from '../store/store'
import type { Provider, AuthType } from '../../shared/types'
import type { CredentialField } from '../store/types'

export interface CustomProviderData {
  id?: string
  name: string
  type?: 'builtin' | 'custom'
  authType: AuthType
  apiEndpoint: string
  headers?: Record<string, string>
  description?: string
  icon?: string
  supportedModels?: string[]
  credentialFields?: CredentialField[]
}

export interface CustomProviderValidation {
  valid: boolean
  errors: string[]
}

export class CustomProviderManager {
  private static validateName(name: string, existingId?: string): CustomProviderValidation {
    const errors: string[] = []
    
    if (!name || name.trim().length === 0) {
      errors.push('Provider name cannot be empty')
    }
    
    if (name.length > 50) {
      errors.push('Provider name cannot exceed 50 characters')
    }
    
    const existing = storeManager.getProviders()
    const duplicate = existing.find(p => p.name.toLowerCase() === name.toLowerCase())
    if (duplicate && duplicate.id !== existingId) {
      errors.push('Provider name already exists')
    }
    
    return { valid: errors.length === 0, errors }
  }

  private static validateApiEndpoint(endpoint: string): CustomProviderValidation {
    const errors: string[] = []
    
    if (!endpoint || endpoint.trim().length === 0) {
      errors.push('API endpoint cannot be empty')
    }
    
    try {
      new URL(endpoint)
    } catch {
      errors.push('Invalid API endpoint format')
    }
    
    if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
      errors.push('API endpoint must start with http:// or https://')
    }
    
    return { valid: errors.length === 0, errors }
  }

  private static validateAuthType(authType: AuthType): CustomProviderValidation {
    const validAuthTypes: AuthType[] = [
      'oauth',
      'token',
      'cookie',
      'userToken',
      'refresh_token',
      'jwt',
      'realUserID_token',
      'tongyi_sso_ticket',
    ]
    
    if (!validAuthTypes.includes(authType)) {
      return { valid: false, errors: ['Invalid authentication type'] }
    }
    
    return { valid: true, errors: [] }
  }

  private static validateHeaders(headers: Record<string, string>): CustomProviderValidation {
    const errors: string[] = []
    
    for (const [key, value] of Object.entries(headers)) {
      if (!key || key.trim().length === 0) {
        errors.push('Header name cannot be empty')
      }
      
      if (key.includes(':') || key.includes('\n')) {
        errors.push(`Header name "${key}" contains invalid characters`)
      }
    }
    
    return { valid: errors.length === 0, errors }
  }

  private static validateCredentialFields(fields: CredentialField[]): CustomProviderValidation {
    const errors: string[] = []
    
    if (!fields || fields.length === 0) {
      return { valid: true, errors: [] }
    }
    
    const names = new Set<string>()
    
    for (const field of fields) {
      if (!field.name || field.name.trim().length === 0) {
        errors.push('Credential field name cannot be empty')
      }
      
      if (names.has(field.name)) {
        errors.push(`Duplicate credential field name "${field.name}"`)
      }
      names.add(field.name)
      
      if (!field.label || field.label.trim().length === 0) {
        errors.push(`Label for credential field "${field.name}" cannot be empty`)
      }
      
      const validTypes = ['text', 'password', 'textarea']
      if (!validTypes.includes(field.type)) {
        errors.push(`Invalid type for credential field "${field.name}"`)
      }
    }
    
    return { valid: errors.length === 0, errors }
  }

  static validate(data: CustomProviderData): CustomProviderValidation {
    const errors: string[] = []
    
    const nameValidation = this.validateName(data.name, data.id)
    errors.push(...nameValidation.errors)
    
    const endpointValidation = this.validateApiEndpoint(data.apiEndpoint)
    errors.push(...endpointValidation.errors)
    
    const authTypeValidation = this.validateAuthType(data.authType)
    errors.push(...authTypeValidation.errors)
    
    if (data.headers) {
      const headersValidation = this.validateHeaders(data.headers)
      errors.push(...headersValidation.errors)
    }
    
    if (data.credentialFields) {
      const fieldsValidation = this.validateCredentialFields(data.credentialFields)
      errors.push(...fieldsValidation.errors)
    }
    
    return { valid: errors.length === 0, errors }
  }

  static create(data: CustomProviderData): Provider {
    // Check if a provider with the same ID already exists
    if (data.id) {
      const existing = storeManager.getProviderById(data.id)
      if (existing) {
        return existing
      }
    }
    
    const validation = this.validate(data)
    
    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.join(', ')}`)
    }
    
    const now = Date.now()
    const provider: Provider = {
      id: data.id || storeManager.generateId(),
      name: data.name.trim(),
      type: data.type || 'custom',
      authType: data.authType,
      apiEndpoint: data.apiEndpoint.trim(),
      headers: data.headers || {},
      enabled: true,
      createdAt: now,
      updatedAt: now,
      description: data.description?.trim(),
      icon: data.icon?.trim(),
      supportedModels: data.supportedModels || [],
      credentialFields: data.credentialFields,
    }
    
    storeManager.addProvider(provider)
    
    storeManager.addLog('info', `Created provider: ${provider.name}`, {
      providerId: provider.id,
    })
    
    return provider
  }

  static update(id: string, updates: Partial<CustomProviderData>): Provider {
    const existing = storeManager.getProviderById(id)
    
    if (!existing) {
      throw new Error(`Provider not found: ${id}`)
    }
    
    if (existing.type === 'builtin') {
      throw new Error('Cannot modify built-in provider')
    }
    
    if (updates.name && updates.name !== existing.name) {
      const nameValidation = this.validateName(updates.name)
      if (!nameValidation.valid) {
        throw new Error(nameValidation.errors.join(', '))
      }
    }
    
    if (updates.apiEndpoint) {
      const endpointValidation = this.validateApiEndpoint(updates.apiEndpoint)
      if (!endpointValidation.valid) {
        throw new Error(endpointValidation.errors.join(', '))
      }
    }
    
    if (updates.authType) {
      const authTypeValidation = this.validateAuthType(updates.authType)
      if (!authTypeValidation.valid) {
        throw new Error(authTypeValidation.errors.join(', '))
      }
    }
    
    if (updates.headers) {
      const headersValidation = this.validateHeaders(updates.headers)
      if (!headersValidation.valid) {
        throw new Error(headersValidation.errors.join(', '))
      }
    }
    
    const updated = storeManager.updateProvider(id, {
      ...updates,
      updatedAt: Date.now(),
    })
    
    if (updated) {
      storeManager.addLog('info', `Updated custom provider: ${existing.name}`, {
        providerId: id,
      })
    }
    
    return updated!
  }

  static delete(id: string): boolean {
    const provider = storeManager.getProviderById(id)
    
    if (!provider) {
      return false
    }
    
    const accounts = storeManager.getAccountsByProviderId(id)
    for (const account of accounts) {
      storeManager.deleteAccount(account.id)
    }
    
    const result = storeManager.deleteProvider(id)
    
    if (result) {
      storeManager.addLog('info', `Deleted provider: ${provider.name}`, {
        providerId: id,
      })
    }
    
    return result
  }

  static duplicate(id: string, newName?: string): Provider {
    const existing = storeManager.getProviderById(id)
    
    if (!existing) {
      throw new Error(`Provider not found: ${id}`)
    }
    
    const name = newName || `${existing.name} (Copy)`
    
    return this.create({
      name,
      authType: existing.authType,
      apiEndpoint: existing.apiEndpoint,
      headers: { ...existing.headers },
      description: existing.description,
      icon: existing.icon,
      supportedModels: existing.supportedModels ? [...existing.supportedModels] : [],
    })
  }

  static exportProvider(id: string): string {
    const provider = storeManager.getProviderById(id)
    
    if (!provider) {
      throw new Error(`Provider not found: ${id}`)
    }
    
    const exportData = {
      name: provider.name,
      authType: provider.authType,
      apiEndpoint: provider.apiEndpoint,
      headers: provider.headers,
      description: provider.description,
      icon: provider.icon,
      supportedModels: provider.supportedModels,
    }
    
    return JSON.stringify(exportData, null, 2)
  }

  static importProvider(jsonData: string): Provider {
    let data: CustomProviderData
    
    try {
      data = JSON.parse(jsonData)
    } catch {
      throw new Error('Invalid JSON format')
    }
    
    return this.create(data)
  }

  static getTemplate(authType: AuthType): CustomProviderData {
    const baseTemplate: CustomProviderData = {
      name: '',
      authType,
      apiEndpoint: '',
      headers: {
        'Content-Type': 'application/json',
      },
      description: '',
      supportedModels: [],
    }
    
    switch (authType) {
      case 'token':
        return {
          ...baseTemplate,
          credentialFields: [
            {
              name: 'apiKey',
              label: 'API Key',
              type: 'password',
              required: true,
              placeholder: 'Enter API Key',
            },
          ],
        }
      
      case 'userToken':
        return {
          ...baseTemplate,
          credentialFields: [
            {
              name: 'token',
              label: 'User Token',
              type: 'password',
              required: true,
              placeholder: 'Enter User Token',
            },
          ],
        }
      
      case 'refresh_token':
        return {
          ...baseTemplate,
          credentialFields: [
            {
              name: 'refresh_token',
              label: 'Refresh Token',
              type: 'password',
              required: true,
              placeholder: 'Enter Refresh Token',
            },
          ],
        }
      
      case 'jwt':
        return {
          ...baseTemplate,
          credentialFields: [
            {
              name: 'token',
              label: 'JWT Token',
              type: 'password',
              required: true,
              placeholder: 'Enter JWT Token',
            },
          ],
        }
      
      case 'realUserID_token':
        return {
          ...baseTemplate,
          credentialFields: [
            {
              name: 'realUserID',
              label: 'User ID',
              type: 'text',
              required: true,
              placeholder: 'Enter User ID',
            },
            {
              name: 'token',
              label: 'JWT Token',
              type: 'password',
              required: true,
              placeholder: 'Enter JWT Token',
            },
          ],
        }
      
      case 'tongyi_sso_ticket':
        return {
          ...baseTemplate,
          credentialFields: [
            {
              name: 'ticket',
              label: 'SSO Ticket',
              type: 'password',
              required: true,
              placeholder: 'Enter SSO Ticket',
            },
          ],
        }
      
      case 'cookie':
        return {
          ...baseTemplate,
          credentialFields: [
            {
              name: 'cookie',
              label: 'Cookie',
              type: 'textarea',
              required: true,
              placeholder: 'Enter Cookie',
            },
          ],
        }
      
      case 'oauth':
        return {
          ...baseTemplate,
          credentialFields: [],
          description: 'OAuth authentication provider',
        }
      
      default:
        return baseTemplate
    }
  }
}

export default CustomProviderManager
