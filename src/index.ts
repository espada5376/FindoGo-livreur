import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import compression from 'compression'
import dotenv from 'dotenv'
import { testConnection } from './config/db'
import authRoutes from './routes/auth'
import commandesRoutes from './routes/commandes'

dotenv.config()

const app = express()
const PORT = Number(process.env.PORT) || 3003

app.use(compression())
app.use(express.json())
app.use(cookieParser())
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',').map(o => o.trim())

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) cb(null, true)
      else cb(null, true) // permissif en prod tant que credentials est géré côté Render
    },
    credentials: true,
  }),
)

app.use('/api/livreurs', authRoutes)
app.use('/api/livreurs', commandesRoutes)

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'livraison' })
})

testConnection().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Serveur Livraison démarré sur le port ${PORT}`)
  })
})
