import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'

describe('governed authoring API', () => {
  it('rejects incomplete query requests before touching the data plane', async () => {
    const response = await createApp().request('/api/authoring/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT * FROM fashion.catalog.products' }),
    })
    expect(response.status).toBe(400)
  })

  it.each([
    'DELETE FROM fashion.catalog.products',
    "SELECT * FROM read_csv_auto('/etc/passwd'), fashion.catalog.products",
    'SELECT * FROM fashion.catalog.products; SELECT 2',
  ])('rejects unsafe authoring SQL without executing it: %s', async (sql) => {
    const response = await createApp().request('/api/authoring/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: 'What does this query return?',
        sql,
        expectedColumns: ['value'],
        maxRows: 10,
      }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toHaveProperty('error')
  })
})
