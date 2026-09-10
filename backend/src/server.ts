import { buildApp } from './app.js'

const PORT = parseInt(process.env.PORT || '3140', 10)

async function main() {
  const app = await buildApp({ serve: true })
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' })
    app.log.info(`Tapis on http://localhost:${PORT}`)
    if (process.send) process.send('ready')
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down`)
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main()
