// ── Google Drive video picker + download ───────────────────────────────────────────────────────
// Lets the user search their own Google Drive (via the official Google Picker — the same browse/search
// UI Google Slides uses) and add a video, either by EMBEDDING it (a drive.google.com/preview iframe,
// instant, no storage) or DOWNLOADING it into Supabase (ad-free MP4 that behaves like an upload).
//
// Needs a free Google Cloud OAuth **Client ID** + **API key** (tied to the user's own Google account).
// The Client ID is public by design; the API key is restricted to PIM's origin. Both are stored in
// localStorage (or provided at build time via VITE_GOOGLE_CLIENT_ID / VITE_GOOGLE_API_KEY).

const LS_ID = 'pim_gdrive_client_id'
const LS_KEY = 'pim_gdrive_api_key'
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly'

export function getDriveCreds() {
  let clientId = '', apiKey = ''
  try { clientId = localStorage.getItem(LS_ID) || '' ; apiKey = localStorage.getItem(LS_KEY) || '' } catch { /* private mode */ }
  clientId = clientId || import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
  apiKey = apiKey || import.meta.env.VITE_GOOGLE_API_KEY || ''
  return { clientId: clientId.trim(), apiKey: apiKey.trim() }
}

export function setDriveCreds(clientId, apiKey) {
  try { localStorage.setItem(LS_ID, (clientId || '').trim()); localStorage.setItem(LS_KEY, (apiKey || '').trim()) } catch { /* ignore */ }
}

export function hasDriveCreds() {
  const { clientId, apiKey } = getDriveCreds()
  return !!(clientId && apiKey)
}

const loadScript = (src) => new Promise((resolve, reject) => {
  if (document.querySelector(`script[data-src="${src}"]`)) return resolve()
  const s = document.createElement('script')
  s.src = src; s.async = true; s.defer = true; s.dataset.src = src
  s.onload = () => resolve()
  s.onerror = () => reject(new Error('Failed to load ' + src))
  document.head.appendChild(s)
})

let pickerLoaded = false
async function ensurePickerLoaded() {
  await loadScript('https://apis.google.com/js/api.js')
  if (!pickerLoaded) {
    await new Promise((res) => window.gapi.load('picker', { callback: res }))
    pickerLoaded = true
  }
  await loadScript('https://accounts.google.com/gsi/client')
}

// Request an OAuth access token (drive.readonly) via Google Identity Services.
function requestAccessToken(clientId) {
  return new Promise((resolve, reject) => {
    let settled = false
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        settled = true
        if (resp && resp.access_token) resolve(resp.access_token)
        else reject(new Error(resp?.error || 'Authorization was cancelled'))
      },
      error_callback: (err) => { settled = true; reject(new Error(err?.message || 'Authorization failed')) },
    })
    client.requestAccessToken({ prompt: '' })
    // Safety: if the popup is closed with no callback, don't hang forever.
    setTimeout(() => { if (!settled) reject(new Error('Authorization timed out')) }, 120000)
  })
}

// Open the Google Picker filtered to videos. Resolves the chosen file, or null if cancelled.
// → { id, name, mimeType, sizeBytes, accessToken }
export async function pickDriveVideo() {
  const { clientId, apiKey } = getDriveCreds()
  if (!clientId || !apiKey) { const e = new Error('missing-creds'); e.code = 'missing-creds'; throw e }
  await ensurePickerLoaded()
  const accessToken = await requestAccessToken(clientId)
  const google = window.google
  return new Promise((resolve, reject) => {
    try {
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS_VIDEOS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false)
      const builder = new google.picker.PickerBuilder()
        .setOAuthToken(accessToken)
        .setDeveloperKey(apiKey)
        .addView(view)
        .addView(new google.picker.DocsView(google.picker.ViewId.DOCS_VIDEOS).setOwnedByMe(true).setLabel('My videos'))
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) {
            const doc = (data.docs || [])[0]
            if (doc) resolve({ id: doc.id, name: doc.name, mimeType: doc.mimeType, sizeBytes: Number(doc.sizeBytes) || 0, accessToken })
            else resolve(null)
          } else if (data.action === google.picker.Action.CANCEL) {
            resolve(null)
          }
        })
      const appId = clientId.split('-')[0]
      if (/^\d+$/.test(appId)) builder.setAppId(appId)
      builder.build().setVisible(true)
    } catch (e) { reject(e) }
  })
}

// Download the raw bytes of a Drive file (needs the access token from pickDriveVideo). → Blob
export async function downloadDriveFile(id, accessToken) {
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
    headers: { Authorization: 'Bearer ' + accessToken },
  })
  if (!resp.ok) throw new Error('Drive download failed (' + resp.status + ')')
  return await resp.blob()
}

export const driveEmbedUrl = (id) => `https://drive.google.com/file/d/${id}/preview`
export const driveThumbUrl = (id) => `https://drive.google.com/thumbnail?id=${id}&sz=w400`
