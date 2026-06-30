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
let isConnecting = false

async function connectToWhatsApp() {
  if (isConnecting) return
  isConnecting = true

  try {
    if (!fs.existsSync('./auth_info')) {
      fs.mkdirSync('./auth_info', { recursive: true })
    }

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      // Sin printQRInTerminal — lo manejamos nosotros
      browser: ['Capy', 'Chrome', '120.0.0'],
      connectTimeoutMs: 30000,
    })

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        console.log('QR recibido, generando imagen...')
        qrCodeData = await QRCode.toDataURL(qr)
        console.log('QR listo en /qr')
      }

      if (connection === 'open') {
        isConnected = true
        isConnecting = false
        qrCodeData = null
        console.log('✅ WhatsApp conectado!')
      }

      if (connection === 'close') {
        isConnected = false
        isConnecting = false
        const statusCode = lastDisconnect?.error?.output?.statusCode
        console.log('Conexión cerrada. Status:', statusCode)

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('Sesión expirada — borrando credenciales')
          fs.rmSync('./auth_info', { recursive: true, force: true })
          qrCodeData = null
        }

        // Reconectar solo si no fue logout — con delay de 10s
        if (statusCode !== DisconnectReason.loggedOut) {
          console.log('Reconectando en 10 segundos...')
          setTimeout(() => {
            isConnecting = false
            connectToWhatsApp()
          }, 10000)
        }
      }
    })

    sock.ev.on('creds.update', saveCreds)

  } catch (err) {
    console.error('Error crítico:', err.message)
    isConnecting = false
    setTimeout(connectToWhatsApp, 15000)
  }
}

function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:white">
      <h2>✅ WhatsApp conectado!</h2>
    </body></html>`)
  }
  if (!qrCodeData) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:white">
      <h2>⏳ Esperando QR...</h2>
      <p>El servicio se está conectando a WhatsApp</p>
      <script>setTimeout(()=>location.reload(),5000)</script>
    </body></html>`)
  }
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:white">
    <h2>Escaneá este QR con WhatsApp</h2>
    <p>WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${qrCodeData}" style="width:280px;border-radius:12px;margin:20px auto;display:block" />
    <p style="color:#666;font-size:12px">El QR expira en 60 segundos</p>
    <script>setTimeout(()=>location.reload(),60000)</script>
  </body></html>`)
})

app.get('/status', auth, (req, res) => {
  res.json({ connected: isConnected, hasQR: !!qrCodeData, connecting: isConnecting })
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
    res.status(500).json({ error: err.message })
  }
})

app.get('/', (req, res) => {
  res.json({ status: 'ok', connected: isConnected, connecting: isConnecting })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Capy WhatsApp corriendo en puerto ${PORT}`)
  // Conectar WhatsApp después de que Express esté escuchando
  setTimeout(connectToWhatsApp, 2000)
})
