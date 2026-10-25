/* global FSP, chrome */
const $ = (id) => document.getElementById(id)

async function main() {
  const { settings } = await chrome.storage.local.get('settings')
  $('enabled').checked = settings?.enabled !== false
  $('enabled').addEventListener('change', (e) => chrome.storage.local.set({ settings: { enabled: e.target.checked } }))

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  let status = null
  try {
    status = await chrome.tabs.sendMessage(tab.id, { type: 'FSP_STATUS' })
  } catch {
    status = null
  }
  if (!status) {
    $('status').textContent = 'Open a film on Netflix, Prime Video, Disney+, Max or YouTube.'
    return
  }
  if (!status.key) {
    $('status').textContent = 'Start playing a title, then open this again.'
    return
  }
  $('status').hidden = true
  $('current').hidden = false
  $('title').textContent = status.title
  const storeKey = `skips:${status.key}`

  const refresh = async () => {
    const entry = (await chrome.storage.local.get(storeKey))[storeKey]
    const n = entry?.segments?.length ?? 0
    $('count').textContent = n
      ? `${n} scene${n === 1 ? '' : 's'} filtered on ${status.site}`
      : `No scenes saved for this title on ${status.site} yet`
    $('export').disabled = !n
    $('clear').disabled = !n
    return entry
  }
  await refresh()

  // File pickers close the popup in Chrome, so importing happens in the options tab.
  $('import').addEventListener('click', () => {
    const q = new URLSearchParams({ key: status.key, title: status.title, site: status.site })
    chrome.tabs.create({ url: `options.html?${q}` })
  })
  $('export').addEventListener('click', async () => {
    const entry = await refresh()
    if (!entry) return
    const blob = new Blob([JSON.stringify(FSP.toSkipFile(entry), null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(entry.title || 'title').replace(/[^\w\- ]+/g, '')}.skips.json`
    a.click()
  })
  $('clear').addEventListener('click', async () => {
    if (!confirm('Remove all saved scenes for this title?')) return
    await chrome.storage.local.remove(storeKey)
    await refresh()
  })
}

main()
