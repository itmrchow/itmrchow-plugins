import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DUPLICATED = [
  'channel-ready',
  'scope-id',
  'subscribe-protocol',
  'poller-registry',
  'subscribe-client',
  'subscribe-server',
  'resolve-port',
]

// These modules exist as an identical copy in each channel plugin. Not laziness:
// a plugin is installed by copying <plugin>/ into
// cache/<marketplace>/<plugin>/<version>/, so a cross-plugin `../` import
// resolves to nothing at runtime and takes the MCP server down at startup.
// The duplication is forced by the packaging model; this test is its price —
// it turns "changed one side, forgot the other" red on the spot.
test.each(DUPLICATED)('%s.ts 與 telegram 版逐位元組相同', name => {
  const here = readFileSync(join(import.meta.dir, `${name}.ts`))
  const there = readFileSync(join(import.meta.dir, '..', 'telegram', `${name}.ts`))
  expect(here.equals(there)).toBe(true)
})
