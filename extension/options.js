/* global FSP, chrome */
const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const target = params.get('key')

if (target) {
  $('importBox').hidden = false
  $('impTitle').textContent = params.get('title') || target
  $('impSite').textContent = `${params.get('site') || ''} · ${target}`
  $('file').addEventListener('change', async (e) => {
    const f = e.target.files[0]
    if (!f) return
    try {
      const parsed = FSP.parseSkipFile(await f.text())
      await chrome.storage.local.set({
        [`skips:${target}`]: { title: params.get('title') || parsed.title, duration: parsed.duration, segments: parsed.segments, updatedAt: Date.now() },
      })
      $('impMsg').className = 'ok'
      $('impMsg').textContent = `Loaded ${parsed.segments.length} scenes from “${parsed.title}”. Go back to the film tab; filtering starts right away.`
      render()
    } catch (err) {
      $('impMsg').className = 'err'
      $('impMsg').textContent = err.message
    }
  })
}

async function render() {
  const all = await chrome.storage.local.get(null)
  const rows = Object.entries(all)
    .filter(([k]) => k.startsWith('skips:'))
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
  $('empty').hidden = rows.length > 0
  const tbody = $('list')
  tbody.replaceChildren()
  for (const [k, entry] of rows) {
    const tr = document.createElement('tr')
    const site = k.slice(6).split(':')[0]
    for (const text of [entry.title || k, site, String(entry.segments?.length ?? 0)]) {
      const td = document.createElement('td')
      td.textContent = text
      tr.appendChild(td)
    }
    const td = document.createElement('td')
    const exp = document.createElement('button')
    exp.textContent = 'Export'
    exp.onclick = () => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([JSON.stringify(FSP.toSkipFile(entry), null, 2)], { type: 'application/json' }))
      a.download = `${(entry.title || 'title').replace(/[^\w\- ]+/g, '')}.skips.json`
      a.click()
    }
    const del = document.createElement('button')
    del.textContent = 'Delete'
    del.className = 'danger'
    del.onclick = async () => {
      if (confirm(`Delete saved scenes for “${entry.title}”?`)) {
        await chrome.storage.local.remove(k)
        render()
      }
    }
    td.append(exp, del)
    tr.appendChild(td)
    tbody.appendChild(tr)
  }
}

render()
