#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const markdown = await readFile(path.join(root, 'SKILL.md'), 'utf8')
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1]
if (!frontmatter) throw new Error('SKILL.md must begin with YAML frontmatter')
const keys = [...frontmatter.matchAll(/^([a-z0-9_-]+):/gm)].map((match) => match[1])
if (keys.join(',') !== 'name,description') throw new Error('SKILL.md frontmatter must contain only name and description')
if (!/^name: fieldboard-author-dashboard$/m.test(frontmatter)) throw new Error('Skill name is invalid')
if (!/^description: .{40,}$/m.test(frontmatter)) throw new Error('Skill description is missing or too short')
if (/\[TODO|TODO:/i.test(markdown)) throw new Error('SKILL.md contains an unresolved TODO')

for (const relative of [
  'agents/openai.yaml',
  'references/bundle-contract.md',
  'references/source-semantics.md',
  'references/chart-authoring.md',
  'scripts/fieldboard-author.mjs',
]) await access(path.join(root, relative))

const interfaceYaml = await readFile(path.join(root, 'agents/openai.yaml'), 'utf8')
if (!interfaceYaml.includes('display_name: "Fieldboard Dashboard Author"')) throw new Error('agents/openai.yaml display name is stale')
if (!interfaceYaml.includes('$fieldboard-author-dashboard')) throw new Error('agents/openai.yaml default prompt must name the skill')

process.stdout.write('Skill is valid!\n')
