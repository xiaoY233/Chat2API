/**
 * Proxy Service Module - Model Mapper
 * Supports mapping request models to actual models
 */

import { storeManager } from '../store/store'
import { ModelMapping, Provider } from '../store/types'

/**
 * Model mapper
 */
export class ModelMapper {
  /**
   * Map model name
   * @param requestedModel Requested model name
   * @param provider Provider (optional, for provider-specific mapping)
   */
  mapModel(requestedModel: string, provider?: Provider): string {
    const config = storeManager.getConfig()
    const mappings = config.modelMappings

    const directMapping = mappings[requestedModel]
    if (directMapping) {
      if (!provider || !directMapping.preferredProviderId || directMapping.preferredProviderId === provider.id) {
        return directMapping.actualModel
      }
    }

    const wildcardMapping = this.findWildcardMapping(requestedModel, mappings, provider)
    if (wildcardMapping) {
      return wildcardMapping.actualModel
    }

    return requestedModel
  }

  /**
   * Find wildcard mapping
   */
  private findWildcardMapping(
    requestedModel: string,
    mappings: Record<string, ModelMapping>,
    provider?: Provider
  ): ModelMapping | null {
    const normalizedRequested = requestedModel.toLowerCase()

    for (const [pattern, mapping] of Object.entries(mappings)) {
      if (pattern.includes('*')) {
        const normalizedPattern = pattern.toLowerCase()

        if (this.matchesPattern(normalizedRequested, normalizedPattern)) {
          if (!provider || !mapping.preferredProviderId || mapping.preferredProviderId === provider.id) {
            return mapping
          }
        }
      }
    }

    return null
  }

  /**
   * Check if model name matches wildcard pattern
   */
  private matchesPattern(modelName: string, pattern: string): boolean {
    if (pattern === '*') {
      return true
    }

    if (pattern.startsWith('*')) {
      return modelName.endsWith(pattern.slice(1))
    }

    if (pattern.endsWith('*')) {
      return modelName.startsWith(pattern.slice(0, -1))
    }

    const parts = pattern.split('*')
    if (parts.length === 2) {
      return modelName.startsWith(parts[0]) && modelName.endsWith(parts[1])
    }

    return false
  }

  /**
   * Get actual model name for a model
   */
  getActualModel(requestedModel: string, providerId?: string): string {
    const config = storeManager.getConfig()
    const mapping = config.modelMappings[requestedModel]

    if (mapping) {
      if (!providerId || !mapping.preferredProviderId || mapping.preferredProviderId === providerId) {
        return mapping.actualModel
      }
    }

    return requestedModel
  }

  /**
   * Get preferred provider for a model
   */
  getPreferredProvider(requestedModel: string): string | undefined {
    const config = storeManager.getConfig()
    const mapping = config.modelMappings[requestedModel]

    return mapping?.preferredProviderId
  }

  /**
   * Get preferred account for a model
   */
  getPreferredAccount(requestedModel: string): string | undefined {
    const config = storeManager.getConfig()
    const mapping = config.modelMappings[requestedModel]

    return mapping?.preferredAccountId
  }

  /**
   * Add model mapping
   */
  addMapping(requestModel: string, actualModel: string, preferredProviderId?: string, preferredAccountId?: string): void {
    const config = storeManager.getConfig()
    config.modelMappings[requestModel] = {
      requestModel,
      actualModel,
      preferredProviderId,
      preferredAccountId,
    }
    storeManager.getStore()?.set('config', config)
  }

  /**
   * Remove model mapping
   */
  removeMapping(requestModel: string): boolean {
    const config = storeManager.getConfig()
    if (config.modelMappings[requestModel]) {
      delete config.modelMappings[requestModel]
      storeManager.getStore()?.set('config', config)
      return true
    }
    return false
  }

  /**
   * Get all mappings
   */
  getAllMappings(): Record<string, ModelMapping> {
    const config = storeManager.getConfig()
    return { ...config.modelMappings }
  }

  /**
   * Get list of providers supporting specified model
   */
  getProvidersForModel(model: string): Provider[] {
    const providers = storeManager.getProviders().filter(p => p.enabled)
    const preferredProviderId = this.getPreferredProvider(model)

    if (preferredProviderId) {
      const preferred = providers.find(p => p.id === preferredProviderId)
      if (preferred) {
        return [preferred]
      }
    }

    return providers.filter(provider => {
      if (!provider.supportedModels || provider.supportedModels.length === 0) {
        return true
      }

      const normalizedModel = model.toLowerCase()
      return provider.supportedModels.some(m => {
        const normalizedSupported = m.toLowerCase()
        if (normalizedSupported.endsWith('*')) {
          return normalizedModel.startsWith(normalizedSupported.slice(0, -1))
        }
        return normalizedSupported === normalizedModel
      })
    })
  }
}

export const modelMapper = new ModelMapper()
export default modelMapper
