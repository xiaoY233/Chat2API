/**
 * Shared Account Utilities
 * Unified logic for adding accounts across different components
 */

import type { Account, Provider } from '../../store/types'

export interface OAuthCredentials {
  [key: string]: string | undefined
}

export interface CredentialField {
  name: string
  label: string
  type: 'text' | 'password'
  required: boolean
  placeholder?: string
  helpText?: string
}

export function mapOAuthCredentials(
  credentials: OAuthCredentials,
  provider: Provider
): Record<string, string> {
  const mappedCredentials: Record<string, string> = {}

  if (!provider.credentialFields || provider.credentialFields.length === 0) {
    console.warn(`[AccountUtils] No credential fields defined for provider ${provider.id}`)
    return credentials as Record<string, string>
  }

  for (const field of provider.credentialFields) {
    const value = credentials[field.name]
    if (value !== undefined && value !== null && value !== '') {
      mappedCredentials[field.name] = value
    } else if (field.required) {
      console.warn(`[AccountUtils] Missing required field ${field.name} for provider ${provider.id}`)
    }
  }

  return mappedCredentials
}

export function validateCredentials(
  credentials: OAuthCredentials,
  provider: Provider
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!provider.credentialFields || provider.credentialFields.length === 0) {
    return { valid: true, errors: [] }
  }

  for (const field of provider.credentialFields) {
    const value = credentials[field.name]
    
    if (field.required && (!value || value.trim() === '')) {
      errors.push(`Field "${field.label}" is required`)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export function createAccount(
  providerId: string,
  credentials: Record<string, string>,
  accountInfo?: {
    name?: string
    email?: string
    userId?: string
  }
): Omit<Account, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    providerId,
    credentials,
    name: accountInfo?.name,
    email: accountInfo?.email,
    userId: accountInfo?.userId,
    status: 'active',
    lastUsed: undefined,
    usageCount: 0,
    metadata: {},
  }
}

export function getAccountDisplayName(account: Account, provider?: Provider): string {
  if (account.name) {
    return account.name
  }

  if (account.email) {
    return account.email
  }

  if (provider) {
    return `${provider.name} Account`
  }

  return `Account ${account.id.slice(0, 8)}`
}

export function maskCredential(value: string, visibleChars: number = 4): string {
  if (value.length <= visibleChars) {
    return '*'.repeat(value.length)
  }

  const visible = value.slice(0, visibleChars)
  const masked = '*'.repeat(value.length - visibleChars)
  return `${visible}${masked}`
}

export function getMaskedCredentials(
  credentials: Record<string, string>,
  provider: Provider
): Record<string, string> {
  const masked: Record<string, string> = {}

  for (const [key, value] of Object.entries(credentials)) {
    const field = provider.credentialFields?.find(f => f.name === key)
    if (field?.type === 'password') {
      masked[key] = maskCredential(value)
    } else {
      masked[key] = value
    }
  }

  return masked
}
