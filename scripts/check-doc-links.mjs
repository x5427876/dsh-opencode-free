import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

function withoutFences(text) {
  let fence
  return text.split(/\r?\n/).map((line) => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !line.slice(match[0].length).trim()) fence = undefined
      return ''
    }
    if (match) {
      fence = match[1]
      return ''
    }
    return line
  }).join('\n')
}

function headings(text) {
  const ids = new Set()
  const lines = withoutFences(text).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^ {0,3}#{1,6}[ \t]+(.+)$/)
    const heading = match?.[1] ?? (/^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[i + 1] ?? '') ? lines[i].trim() : '')
    if (!heading) continue
    const title = heading.replace(/<[^>]*>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').trim().replace(/\s/g, '-')
    let id = base
    for (let suffix = 1; ids.has(id); suffix++) id = `${base}-${suffix}`
    ids.add(id)
  }
  for (const match of lines.join('\n').matchAll(/<a\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) ids.add(match[1])
  return ids
}

function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean)
  const errors = []
  let checked = 0
  for (const file of new Set(files)) {
    const source = resolve(root, file)
    if (!existsSync(source)) continue // Deleted tracked documents are not inputs.
    const text = withoutFences(readFileSync(source, 'utf8')).replace(/(`+)[^\n]*?\1/g, '')
    // Inline destinations (including one nested parenthesis pair) and reference definitions.
    const links = /\]\(\s*(<[^>\n]+>|(?:[^()\s]|\([^()\n]*\))+)(?:[ \t]+["'][^"\n]*["'])?\s*\)|^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]+>|[^\s]+)/gm
    for (const match of text.matchAll(links)) {
      const raw = match[1] ?? match[2]
      const target = raw.startsWith('<') ? raw.slice(1, -1) : raw
      if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) continue
      checked++
      try {
        const [pathname, fragment] = target.split('#')
        const relative = pathname.split('?')[0]
        const destination = relative ? resolve(dirname(source), decodeURIComponent(relative)) : source
        if (!existsSync(destination)) errors.push(`${file}: missing file ${target}`)
        else if (fragment && /\.md$/i.test(destination) && !headings(readFileSync(destination, 'utf8')).has(decodeURIComponent(fragment))) {
          errors.push(`${file}: missing anchor ${target}`)
        }
      } catch {
        errors.push(`${file}: invalid local link ${target}`)
      }
    }
  }
  for (const error of errors) console.error(error)
  console.log(`${checked} local links checked; ${errors.length} errors.`)
  if (errors.length) process.exitCode = 1
}

try {
  main()
} catch {
  console.error('Document link check could not run; use a readable Git working tree.')
  process.exitCode = 1
}
