import * as XLSX from 'xlsx'

/** Lê um arquivo de contatos (CSV/TXT como texto puro, .xlsx/.xls convertido pra CSV primeiro). */
export async function readContactsFile(file: File): Promise<string> {
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    return sheet ? XLSX.utils.sheet_to_csv(sheet) : ''
  }
  return file.text()
}

/** Lê CSV/colagem: separa por ; , tab, aceita aspas e descobre as colunas de nome e telefone. */
export function parseContacts(text: string): { name: string; phone: string }[] {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return []
  const sample = lines[0]
  const delimiter = ['\t', ';', ','].map((d) => ({ d, n: sample.split(d).length })).sort((a, b) => b.n - a.n)[0].d
  const split = (line: string) => {
    const out: string[] = []; let cur = ''; let quoted = false
    for (const ch of line) {
      if (ch === '"') quoted = !quoted
      else if (ch === delimiter && !quoted) { out.push(cur.trim()); cur = '' } else cur += ch
    }
    out.push(cur.trim()); return out
  }
  const rows = lines.map(split)
  const isPhone = (v: string) => v.replace(/\D/g, '').length >= 10
  const header = rows[0].some((c) => /^(nome|name|paciente|cliente|telefone|celular|fone|whatsapp|phone)/i.test(c)) && !rows[0].some(isPhone)
  let nameCol = -1; let phoneCol = -1
  if (header) {
    nameCol = rows[0].findIndex((c) => /nome|name|paciente|cliente/i.test(c))
    phoneCol = rows[0].findIndex((c) => /telefone|celular|fone|whats|phone|contato/i.test(c))
  }
  const body = header ? rows.slice(1) : rows
  if (phoneCol < 0) phoneCol = Math.max(0, (body[0] ?? []).findIndex(isPhone))
  if (nameCol < 0) nameCol = (body[0] ?? []).findIndex((c, i) => i !== phoneCol && !!c && !isPhone(c))
  return body.map((r) => ({ name: nameCol >= 0 ? r[nameCol] ?? '' : '', phone: r[phoneCol] ?? '' })).filter((r) => r.phone)
}
