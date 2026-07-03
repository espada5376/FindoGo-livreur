import http from 'http'
import https from 'https'

const BASE_URL = (process.env.WHATSAPP_API_URL || '').replace(/\/$/, '')
const API_KEY  = process.env.WHATSAPP_API_KEY || ''

function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '')
  return digits.startsWith('228') ? digits.substring(3) : digits
}

async function httpPost(url: string, body: object): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const payload  = JSON.stringify(body)
    const urlObj   = new URL(url)
    const isHttps  = urlObj.protocol === 'https:'
    const transport = isHttps ? https : http
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'X-Api-Key':      API_KEY,
        'Content-Length': Buffer.byteLength(payload),
      },
    }
    const req = transport.request(options, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
    })
    req.on('error', reject)
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(payload)
    req.end()
  })
}

export async function sendWhatsAppMessage(phone: string, message: string): Promise<void> {
  if (!BASE_URL) {
    console.warn('[whatsapp] WHATSAPP_API_URL non défini — message ignoré')
    return
  }
  const chatId = `228${normalizePhone(phone)}@c.us`
  try {
    await httpPost(`${BASE_URL}/startTyping`, { chatId, session: 'default' })
    const delay = Math.max(2000, Math.min(message.length * 50, 8000))
    await new Promise(r => setTimeout(r, delay))
    await httpPost(`${BASE_URL}/stopTyping`, { chatId, session: 'default' })
    const res = await httpPost(`${BASE_URL}/sendText`, { chatId, text: message, session: 'default' })
    if (res.status < 200 || res.status >= 300) {
      console.error(`[whatsapp] Envoi échoué (${res.status}) pour ${phone}`)
    }
  } catch (err) {
    console.error('[whatsapp] Erreur envoi:', err)
  }
}

export function livreurEnRouteTemplate(params: {
  nom_client: string
  titre_annonce: string
  quantite: number
  nom_livreur: string
  tel_livreur: string
}): string {
  return `🚴 *Votre commande est en route !*

Bonjour ${params.nom_client} 👋

Notre livreur *${params.nom_livreur}* se dirige vers vous avec :
🛍 *${params.titre_annonce}* × ${params.quantite}

📞 Livreur : ${params.tel_livreur}

Merci de rester disponible. Il arrive bientôt ! 🙏`
}

export function accuseReceptionTemplate(params: {
  nom_client: string
  titre_annonce: string
  quantite: number
  id_commande: number
  appUrl: string
}): string {
  const lien = `${params.appUrl}/confirmer-reception?token=${params.id_commande}`
  return `✅ *Commande livrée !*

Bonjour ${params.nom_client} 👋

Votre commande *${params.titre_annonce}* × ${params.quantite} vous a été remise par notre livreur.

Merci de confirmer la réception en cliquant sur le lien ci-dessous :
👉 ${lien}

_TogoMarket_`
}
