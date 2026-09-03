import { openDatabase, migrateDatabase } from '../main/database'
import { join } from 'node:path'
import { createWebServer } from './server'
import { createSqliteStorage } from './storage'
import { createLocalWorkerRuntime } from './worker'

const dataPath = process.env.AGENT_OFFICE_WEB_DATA || '.agent-office-web'
const token = process.env.AGENT_OFFICE_WEB_TOKEN
if (!token) throw new Error('AGENT_OFFICE_WEB_TOKEN is required')
const database = openDatabase(dataPath)
migrateDatabase(database)
const storage = createSqliteStorage(database)
const worker = createLocalWorkerRuntime()
const staticDir = process.env.AGENT_OFFICE_WEB_STATIC_DIR || join(process.cwd(), 'dist', 'web')
const { server } = createWebServer({ storage, token, worker, userDataPath: dataPath, staticDir })
const host = process.env.AGENT_OFFICE_WEB_HOST || '127.0.0.1'
const port = Number(process.env.AGENT_OFFICE_WEB_PORT || 8787)
server.listen(port, host, () => console.log(`Agent Office web API listening on ${host}:${port}`))
process.once('SIGTERM', () => { server.close(); database.close() })
process.once('SIGINT', () => { server.close(); database.close() })
