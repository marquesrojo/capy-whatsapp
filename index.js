const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const express = require('express')
const QRCode = require('qrcode')
const pino = require('pino')

const app = express()
app.use(express.json())

// API Key para seguridad
const API_KEY = process.env.CAPY_API_KEY || 'capy-whatsapp-secret'

let sock = null
let qrCodeData = null
let isConnected = false

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Capy', 'Chrome', '1.0.0']
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      qrCodeData = await QRCode.toDataURL(qr)
      isConnected = false
      console.log('QR generado — escanealo desde /qr')
    }

    if (connection === 'close') {
      isConnected = false
      qrCodeData = null
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('Conexión cerrada, reconectando:', shouldReconnect)
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000)
      }
    } else if (connection === 'open') {
      isConnected = true
      qrCodeData = null
      console.log('✅ WhatsApp conectado!')
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

// Middleware de autenticación
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// GET /qr — muestra el QR para escanear
app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.send('<h2>✅ WhatsApp ya está conectado!</h2>')
  }
  if (!qrCodeData) {
    return res.send('<h2>Generando QR... recargá en unos segundos</h2><script>setTimeout(()=>location.reload(),3000)</script>')
  }
  res.send(`
    <html>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#1a1a1a;color:white">
        <h2>Escaneá este QR con WhatsApp</h2>
        <p>Abrí WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
        <img src="${qrCodeData}" style="width:300px;border-radius:12px" />
        <p>Esta página se actualiza automáticamente</p>
        <script>setTimeout(()=>location.reload(),15000)</script>
      </body>
    </html>
  `)
})

// GET /status — estado de la conexión
app.get('/status', auth, (req, res) => {
  res.json({ connected: isConnected, hasQR: !!qrCodeData })
})

// POST /send — enviar mensaje
app.post('/send', auth, async (req, res) => {
  const { to, message } = req.body

  if (!to || !message) {
    return res.status(400).json({ error: 'Falta "to" o "message"' })
  }

  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'WhatsApp no está conectado' })
  }

  try {
    // Formatear número — agregar @s.whatsapp.net
    const number = to.replace(/\D/g, '')
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`

    await sock.sendMessage(jid, { text: message })
    res.json({ success: true, to: jid })
  } catch (err) {
    console.error('Error enviando mensaje:', err)
    res.status(500).json({ error: err.message })
  }
})

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', connected: isConnected })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Capy WhatsApp service corriendo en puerto ${PORT}`)
  connectToWhatsApp()
})
