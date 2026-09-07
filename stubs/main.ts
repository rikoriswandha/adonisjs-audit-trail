import { fileURLToPath } from 'node:url'

/**
 * Path to the root directory where the stubs are stored. We use
 * this path within commands and the configure hook.
 */
export const stubsRoot = fileURLToPath(new URL('./', import.meta.url))
