#!/usr/bin/env node
// ECC is MIT, but a few skills carry their own licenses (Apache-2.0, CC-BY-SA-4.0). The fork keeps only
// their frontmatter plus a link to the upstream original, so their full text is not redistributed here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(ROOT, 'ecc', 'skills');
const UPSTREAM = 'https://github.com/affaan-m/ECC/tree/main/skills';

for (const id of fs.readdirSync(SKILLS)) {
  const file = path.join(SKILLS, id, 'SKILL.md');
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const license = fm?.[1].match(/^license:\s*["']?([^"'\n]+)/m)?.[1].trim();
  if (!license || /^mit$/i.test(license)) continue;
  const stub = `---\n${fm[1]}\n---\n\nThis skill is licensed under ${license}, not ECC's MIT license, so this fork keeps only its\nfrontmatter. Read the original at ${UPSTREAM}/${id}\n`;
  fs.writeFileSync(file, stub);
  console.log(`[stub] ${id} (${license})`);
}
