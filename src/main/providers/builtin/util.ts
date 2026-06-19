import fs from 'fs'
import path from 'path'
import { homedir } from 'os'

`
import { getFileConfig } from './util'
const configs = getFileConfig('models.json', {
  modelMappings: {
    "Model-1": "model-1"
  }
})

export const aiConfig: BuiltinProviderConfig = {
  ...
  supportedModels: Object.keys(configs.modelMappings || {}),
  modelMappings: configs.modelMappings,
  ...
}
`

const parentDir = path.join(homedir(), '.chat2api', 'models')
export function getFileConfig(filename: string, defaultConfig: Record<string, any>): Record<string, any> {
  const filepath = path.join(parentDir, filename)
  try {
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true })
    }

    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, 'utf-8')
      
      try {
        return JSON.parse(content)
      } catch (parseError) {
        console.error(`[Config] JSON parse error in ${filepath}. Backing up corrupted file and using defaults.`)
        fs.renameSync(filepath, `${filepath}.bak`)
        fs.writeFileSync(filepath, JSON.stringify(defaultConfig, null, 2), 'utf-8')
        return defaultConfig
      }
    } else {
      console.log(`[Config] File not found at ${filepath}. Creating with defaults.`)
      fs.writeFileSync(filepath, JSON.stringify(defaultConfig, null, 2), 'utf-8')
      return defaultConfig
    }
  } catch (error) {
    console.error(`[Config] Failed to load config from ${filepath}, falling back to defaults.`, error)
    try {
      fs.writeFileSync(filepath, JSON.stringify(defaultConfig, null, 2), 'utf-8')
    } catch (writeError) {
      console.error('[Config] Failed to write default config.', writeError)
    }
    return defaultConfig
  }
}
