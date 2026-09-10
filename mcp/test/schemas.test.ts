import { z } from 'zod'
import { ALL_TOOLS } from '../src/registry.js'

/**
 * JSON Schema snapshots for every tool input.
 *
 * These are the contract downstream agents code against. A diff here means a
 * consumer-visible change: review it, don't just update the snapshot.
 */
describe('tool input schemas', () => {
  it('matches the published JSON Schema snapshot', () => {
    const schemas: Record<string, unknown> = {}
    for (const tool of ALL_TOOLS) {
      schemas[tool.name] = z.toJSONSchema(z.object(tool.inputShape))
    }
    expect(schemas).toMatchSnapshot()
  })

  it('requires a sender on every prepare tool', () => {
    for (const tool of ALL_TOOLS.filter((t) => t.kind === 'prepare')) {
      const schema = z.toJSONSchema(z.object(tool.inputShape)) as {
        required?: string[]
      }
      expect(schema.required).toContain('sender')
    }
  })

  it('never asks for key material', () => {
    const forbidden = /privateKey|secret|mnemonic|seed|apiKey|api_key/i
    for (const tool of ALL_TOOLS) {
      for (const field of Object.keys(tool.inputShape)) {
        expect(field).not.toMatch(forbidden)
      }
    }
  })

  it('takes u64-ish values as strings, never as numbers', () => {
    const numericNames =
      /^(price|quantity|amount|newQuantity|quoteBudget|quoteDeposit|expireAt)$/
    for (const tool of ALL_TOOLS) {
      const schema = z.toJSONSchema(z.object(tool.inputShape)) as {
        properties?: Record<string, { type?: string }>
      }
      for (const [field, def] of Object.entries(schema.properties ?? {})) {
        if (numericNames.test(field)) {
          expect(def.type).not.toBe('number')
          expect(def.type).not.toBe('integer')
        }
      }
    }
  })

  it('documents every tool with a description', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(30)
      expect(tool.title.length).toBeGreaterThan(3)
    }
  })

  it('tells the model that prepare tools do not submit', () => {
    for (const tool of ALL_TOOLS.filter((t) => t.kind === 'prepare')) {
      expect(tool.description).toMatch(/never signs or submits/)
    }
  })
})
