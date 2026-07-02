import { Router, Request, Response } from 'express'
import { isLivreur } from '../middleware/isLivreur'
import {
  getCommandesProches,
  getCommandeDetails,
  getMesLivraisons,
  signalerEchec,
} from '../models/livreurs'
import { pool } from '../config/db'
import { sendWhatsAppMessage, livreurEnRouteTemplate } from '../utils/whatsapp'

const router = Router()

const RAISONS_VALIDES = ['absente', 'injoignable', 'refusee', 'paiement_echoue', 'mauvaise_adresse']

// ── Haversine distance (km) ────────────────────────────────────────────────
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R    = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── POST /commandes/auto-tournee ────────────────────────────────────────────
// Le livreur envoie sa position → on lui affecte jusqu'à 5 commandes
// des boutiques les plus proches (coordonnées boutique pour le pickup).
router.post('/auto-tournee', isLivreur, async (req: Request, res: Response) => {
  const { latitude, longitude, livreurId } = req.body ?? {}
  if (!latitude || !longitude)
    return res.status(400).json({ success: false, message: 'Position manquante' })

  const lat = Number(latitude)
  const lng = Number(longitude)
  if (isNaN(lat) || isNaN(lng))
    return res.status(400).json({ success: false, message: 'Coordonnées invalides' })

  try {
    // Toutes les commandes en attente non assignées dont la boutique a des coordonnées
    const { rows } = await pool.query<{
      id_commande: number
      id_client_utilisateur: number | null
      nom_client_commande: string
      tel_client_commande: string
      quantite_commande: number
      mode_paiement_commande: string
      quartier: string | null
      lieu_reference: string | null
      date_commande: string
      titre_annonce: string
      prix_unitaire_annonce: number
      photos: string[]
      id_boutique: number
      nom_boutique: string
      tel_boutique: string
      whatsapp_boutique: string | null
      latitude_boutique: number
      longitude_boutique: number
      nom_livreur: string
      tel_livreur: string
    }>(
      `SELECT c.id_commande, c.id_client_utilisateur,
              c.nom_client_commande, c.tel_client_commande,
              c.quantite_commande, c.mode_paiement_commande,
              c.quartier, c.lieu_reference, c.date_commande,
              a.titre_annonce, a.prix_unitaire_annonce, a.photos,
              b.id_boutique, b.nom_boutique, b.tel_boutique, b.whatsapp_boutique,
              b.latitude_boutique, b.longitude_boutique,
              lv.nom_livreur, lv.tel_livreur
       FROM commandes c
       JOIN annonces  a  ON a.id_annonce  = c.id_annonce
       JOIN boutiques b  ON b.id_boutique = c.id_boutique
       JOIN livreurs  lv ON lv.id_livreur = $1
       WHERE c.status_commande::text = 'nouvelle commande'
         AND c.id_livreur IS NULL
         AND b.latitude_boutique  IS NOT NULL
         AND b.longitude_boutique IS NOT NULL
       ORDER BY c.date_commande ASC`,
      [livreurId],
    )

    if (rows.length === 0)
      return res.json({ success: true, commandes: [], message: 'Aucune commande disponible près de vous' })

    // Distance livreur → boutique pour chaque commande
    const withDist = rows
      .map(r => ({ ...r, distance_km: haversine(lat, lng, r.latitude_boutique, r.longitude_boutique) }))
      .sort((a, b) => a.distance_km - b.distance_km)

    // Sélection : on parcourt les boutiques par distance croissante,
    // on prend toutes leurs commandes jusqu'à atteindre 5 au total.
    const selected: typeof withDist = []
    const boutiquesVues = new Set<number>()

    for (const r of withDist) {
      if (selected.length >= 5) break
      boutiquesVues.add(r.id_boutique)
      selected.push(r)
    }

    // Réservation en transaction : on assigne le livreur sans changer le statut.
    // Le statut "livreur en route" + WhatsApp se déclenchent via /demarrer-livraison.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const ids = selected.map(s => s.id_commande)
      const updated = await client.query<{ id_commande: number }>(
        `UPDATE commandes
         SET id_livreur = $1
         WHERE id_commande = ANY($2)
           AND status_commande::text = 'nouvelle commande'
           AND id_livreur IS NULL
         RETURNING id_commande`,
        [livreurId, ids],
      )

      await client.query('COMMIT')

      const assignedIds = new Set(updated.rows.map(r => r.id_commande))
      const result = selected
        .filter(s => assignedIds.has(s.id_commande))
        .map(s => ({ ...s, distance_km: Math.round(s.distance_km * 10) / 10 }))

      res.json({ success: true, commandes: result, nb_assignees: result.length })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    console.error('[auto-tournee]', err)
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── POST /commandes/demarrer-livraison ────────────────────────────────────
// Livreur clique "Je pars vers le client" → statut en route + notif + WhatsApp
router.post('/demarrer-livraison', isLivreur, async (req: Request, res: Response) => {
  const { id_commande, livreurId } = req.body ?? {}
  if (!id_commande)
    return res.status(400).json({ success: false, message: 'id_commande manquant' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const updated = await client.query<{ id_commande: number; id_client_utilisateur: number | null }>(
      `UPDATE commandes
       SET status_commande = 'livreur en route'
       WHERE id_commande = $1
         AND id_livreur  = $2
         AND status_commande::text = 'nouvelle commande'
       RETURNING id_commande, id_client_utilisateur`,
      [Number(id_commande), livreurId],
    )

    if (!updated.rows[0]) {
      await client.query('ROLLBACK')
      return res.status(409).json({ success: false, message: 'Commande introuvable ou déjà en route' })
    }

    const idClient = updated.rows[0].id_client_utilisateur
    if (idClient) {
      await client.query(
        `INSERT INTO notifications
           (id_utilisateur, role_notification, context_notification, reference_id, status_notification, date_envoi_notification)
         VALUES ($1, 'acheteur', 'commande_livreur_en_route', $2, 0, NOW())`,
        [idClient, id_commande],
      )
    }

    await client.query('COMMIT')

    // WhatsApp (non-bloquant)
    const { rows } = await pool.query(
      `SELECT c.nom_client_commande, c.tel_client_commande,
              c.quantite_commande, a.titre_annonce,
              lv.nom_livreur, lv.tel_livreur
       FROM commandes c
       JOIN annonces a ON a.id_annonce = c.id_annonce
       JOIN livreurs lv ON lv.id_livreur = $1
       WHERE c.id_commande = $2 LIMIT 1`,
      [livreurId, Number(id_commande)],
    )
    const cmd = rows[0]
    if (cmd?.tel_client_commande) {
      sendWhatsAppMessage(cmd.tel_client_commande, livreurEnRouteTemplate({
        nom_client:    cmd.nom_client_commande,
        titre_annonce: cmd.titre_annonce,
        quantite:      cmd.quantite_commande,
        nom_livreur:   cmd.nom_livreur,
        tel_livreur:   cmd.tel_livreur,
      })).catch(() => {})
    }

    res.json({ success: true })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('[demarrer-livraison]', err)
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  } finally {
    client.release()
  }
})

router.post('/commandes-proches', isLivreur, async (req: Request, res: Response) => {
  try {
    const { latitude, longitude } = req.body ?? {}
    if (!latitude || !longitude)
      return res.status(400).json({ success: false, message: 'Position manquante' })

    const commandes = await getCommandesProches(Number(latitude), Number(longitude))
    res.json({ success: true, commandes })
  } catch (err) {
    console.error(err)
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

router.get('/commande/:id', isLivreur, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params['id'] as string, 10)
    if (!id) return res.status(400).json({ success: false, message: 'ID invalide' })

    const commande = await getCommandeDetails(id)
    if (!commande)
      return res.status(404).json({ success: false, message: 'Commande introuvable' })

    res.json({ success: true, commande })
  } catch (err) {
    console.error(err)
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

router.get('/mes-livraisons', isLivreur, async (req: Request, res: Response) => {
  try {
    const { livreurId } = req.body
    const statut = (req.query.statut as string) || 'livreur en route'
    const livraisons = await getMesLivraisons(livreurId, statut)
    res.json({ success: true, livraisons })
  } catch (err) {
    console.error(err)
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

router.post('/prendre-commande', isLivreur, async (req: Request, res: Response) => {
  const client = await pool.connect()
  try {
    const { id_commande, livreurId } = req.body ?? {}
    if (!id_commande)
      return res.status(400).json({ success: false, message: 'id_commande manquant' })

    await client.query('BEGIN')

    const result = await client.query(
      `UPDATE commandes
       SET status_commande = 'livreur en route', id_livreur = $1
       WHERE id_commande = $2
         AND status_commande::text = 'nouvelle commande'
         AND id_livreur IS NULL
       RETURNING id_commande, id_client_utilisateur`,
      [livreurId, Number(id_commande)],
    )

    if (!result.rows[0]) {
      await client.query('ROLLBACK')
      return res.status(409).json({ success: false, message: 'Commande déjà prise ou introuvable' })
    }

    const idClient = result.rows[0].id_client_utilisateur
    if (idClient) {
      await client.query(
        `INSERT INTO notifications (id_utilisateur, role_notification, context_notification, reference_id, status_notification, date_envoi_notification)
         VALUES ($1, 'acheteur', 'commande_livreur_en_route', $2, 0, NOW())`,
        [idClient, id_commande],
      )
    }

    await client.query('COMMIT')
    res.json({ success: true, message: 'Commande prise en charge' })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(err)
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  } finally {
    client.release()
  }
})

router.post('/confirmer-livraison', isLivreur, async (req: Request, res: Response) => {
  const client = await pool.connect()
  try {
    const { id_commande, livreurId } = req.body ?? {}
    if (!id_commande)
      return res.status(400).json({ success: false, message: 'id_commande manquant' })

    await client.query('BEGIN')

    const updated = await client.query(
      `UPDATE commandes
       SET status_commande = 'produit livré et payé'
       WHERE id_commande = $1
         AND id_livreur  = $2
         AND status_commande::text = 'livreur en route'
       RETURNING id_commande, id_client_utilisateur`,
      [Number(id_commande), livreurId],
    )

    if (!updated.rows[0]) {
      await client.query('ROLLBACK')
      return res.status(409).json({ success: false, message: 'Impossible de confirmer cette livraison' })
    }

    const idClient = updated.rows[0].id_client_utilisateur
    if (idClient) {
      await client.query(
        `INSERT INTO notifications (id_utilisateur, role_notification, context_notification, reference_id, status_notification, date_envoi_notification)
         VALUES ($1, 'acheteur', 'commande_livreur_arrive', $2, 0, NOW())`,
        [idClient, id_commande],
      )

      const { rows } = await client.query(
        `SELECT sc.delai_reapprovisionnement
         FROM commandes c
         INNER JOIN annonces        a  ON a.id_annonce        = c.id_annonce
         INNER JOIN sous_categories sc ON sc.id_sous_categorie = a.id_sous_categorie
         WHERE c.id_commande = $1 LIMIT 1`,
        [id_commande],
      )
      const delai = rows[0]?.delai_reapprovisionnement
      if (delai && delai > 0) {
        await client.query(
          `INSERT INTO notifications (id_utilisateur, role_notification, context_notification, reference_id, status_notification, date_envoi_notification)
           VALUES ($1, 'acheteur', 'reapprovisionnement', $2, 0, NOW() + ($3 || ' days')::interval)`,
          [idClient, id_commande, delai],
        )
      }
    }

    await client.query('COMMIT')
    res.json({ success: true, message: 'Livraison confirmée' })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(err)
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  } finally {
    client.release()
  }
})

router.post('/echec-livraison', isLivreur, async (req: Request, res: Response) => {
  const client = await pool.connect()
  try {
    const { id_commande, raison, livreurId } = req.body ?? {}
    if (!id_commande || !raison || !RAISONS_VALIDES.includes(raison))
      return res.status(400).json({ success: false, message: 'id_commande et raison valide requis' })

    await client.query('BEGIN')
    const updated = await signalerEchec(Number(id_commande), livreurId, raison)
    if (!updated) {
      await client.query('ROLLBACK')
      return res.status(409).json({ success: false, message: "Impossible de signaler l'échec" })
    }
    if (updated.id_client_utilisateur) {
      await client.query(
        `INSERT INTO notifications (id_utilisateur, role_notification, context_notification, reference_id, status_notification, date_envoi_notification)
         VALUES ($1, 'acheteur', 'commande_echec_livraison', $2, 0, NOW())`,
        [updated.id_client_utilisateur, id_commande],
      )
    }
    await client.query('COMMIT')
    res.json({ success: true, message: 'Échec signalé' })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(err)
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  } finally {
    client.release()
  }
})

export default router
