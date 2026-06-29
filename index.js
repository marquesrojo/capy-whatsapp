const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const express = require('express')
const QRCode = require('qrcode')
const pino = require('pino')
const fs = require('fs')

const app = express()
app.use(express.json())

const API_KEY = process.env.CAPY_API_KEY || 'capy-whatsapp-secret'

let sock = null
let qrCodeData = null
let isConnected = false
let reconnectAttempts = 0

async function connectToWhatsApp() {
  try {
    // Crear carpeta auth si no existe
    if (!fs.existsSync('./auth_info')) {
      fs.mkdirSync('./auth_info')
    }

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
    const version = [2, 3000, 1015901307]
    
    console.log('Iniciando conexión...')

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'warn' }),
      printQRInTerminal: true,
      browser: ['Capy', 'Chrome', '120.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
    })

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update
      console.log('Connection update:', JSON.stringify({ connection, qr: !!qr }))

      if (qr) {
        try {
          qrCodeData = await QRCode.toDataURL(qr)
          isConnected = false
          reconnectAttempts = 0
          console.log('✅ QR generado exitosamente')
        } catch (err) {
          console.error('Error generando QR:', err)
        }
      }

      if (connection === 'close') {
        isConnected = false
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const errorMsg = lastDisconnect?.error?.message || 'Unknown'
        console.log(`Conexión cerrada. Status: ${statusCode}, Error: ${errorMsg}`)
        
        if (statusCode === DisconnectReason.loggedOut) {
          console.log('Sesión cerrada — borrando credenciales')
          fs.rmSync('./auth_info', { recursive: true, force: true })
          qrCodeData = null
        }
        
        reconnectAttempts++
        const delay = Math.min(reconnectAttempts * 3000, 30000)
        console.log(`Reconectando en ${delay}ms (intento ${reconnectAttempts})`)
        setTimeout(connectToWhatsApp, delay)
        
      } else if (connection === 'open') {
        isConnected = true
        qrCodeData = null
        reconnectAttempts = 0
        console.log('✅ WhatsApp conectado!')
      }
    })

    sock.ev.on('creds.update', saveCreds)

  } catch (err) {
    console.error('Error al conectar:', err)
    reconnectAttempts++
    setTimeout(connectToWhatsApp, 5000)
  }
}

function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#1a1a1a;color:white"><h2>✅ WhatsApp conectado!</h2></body></html>')
  }
  if (!qrCodeData) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#1a1a1a;color:white">
      <h2>Generando QR...</h2>
      <p>Intento de conexión: ${reconnectAttempts}</p>
      <p>Recargá en unos segundos</p>
      <script>setTimeout(()=>location.reload(),4000)</script>
    </body></html>`)
  }
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#1a1a1a;color:white">
    <h2>Escaneá este QR con WhatsApp</h2>
    <p>WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${qrCodeData}" style="width:280px;border-radius:12px;margin:20px auto;display:block" />
    <p style="color:#888">Esta página se actualiza automáticamente</p>
    <script>setTimeout(()=>location.reload(),20000)</script>
  </body></html>`)
})

app.get('/status', auth, (req, res) => {
  res.json({ connected: isConnected, hasQR: !!qrCodeData, attempts: reconnectAttempts })
})

app.post('/send', auth, async (req, res) => {
  const { to, message } = req.body
  if (!to || !message) return res.status(400).json({ error: 'Falta "to" o "message"' })
  if (!isConnected || !sock) return res.status(503).json({ error: 'WhatsApp no conectado' })

  try {
    const number = to.replace(/\D/g, '')
    const jid = `${number}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: message })
    res.json({ success: true, to: jid })
  } catch (err) {
    console.error('Error enviando:', err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/', (req, res) => {
  res.json({ status: 'ok', connected: isConnected, attempts: reconnectAttempts })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Capy WhatsApp corriendo en puerto ${PORT}`)
  connectToWhatsApp()
})
