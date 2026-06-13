import { readFile } from 'node:fs/promises'
import type { CommandMetaData } from '@adonisjs/ace/types'

let commandsMetaData: CommandMetaData[] | undefined

export async function getMetaData(): Promise<CommandMetaData[]> {
  if (commandsMetaData) {
    return commandsMetaData
  }

  const commandsIndex = await readFile(new URL('./commands.json', import.meta.url), 'utf-8')
  commandsMetaData = (JSON.parse(commandsIndex).commands as CommandMetaData[]) ?? []
  return commandsMetaData
}

export async function getCommand(metaData: CommandMetaData) {
  const commands = await getMetaData()
  const command = commands.find(({ commandName }) => metaData.commandName === commandName)
  if (!command) {
    return null
  }

  // Runtime-selected module: command path comes from generated commands.json
  const { default: commandConstructor } = await import(
    new URL(command.filePath, import.meta.url).href
  )
  return commandConstructor
}
