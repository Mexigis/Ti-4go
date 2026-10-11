/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * API de bitácora de ingesta GIS/CAD.
 *
 * POST /api/ingest — registra metadatos de auditoría de un archivo ingestado
 *                    (nunca el contenido: el parseo es 100 % local).
 * GET  /api/ingest — últimos registros + conteo total.
 *
 * P1-seguridad (Task 63 · directiva checkpoint — hallazgos M-01/M-02 del
 * Task 60): TECHO FIFO por IP con ventana deslizante. El límite corre ANTES
 * de la validación de payload (es un guardia de flood, no de contrato) —
 * sin excepciones: todo request consume cupo. Excedido ⇒ 429 + Retry-After.
 *
 * Alcance honesto: el contador es EN-MEMORIA por instancia de servidor
 * (SQLite + despliegue monolítico actual). Bajo múltiples instancias el
 * techo se vuelve por-instancia — la migración a un store compartido
 * (edge/Redis) es decisión de la FASE de escalado, no de esta ventana.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

const IngestRecordInput = z.object({
  fileName: z.string().min(1).max(200),
  format: z.string().min(1).max(24),
  sizeBytes: z.number().int().min(0).max(60 * 1024 * 1024),
  status: z.enum(['done', 'error']),
  entities: z.record(z.string(), z.number().int().min(0)).nullable().optional(),
  crs: z.string().max(60).nullable().optional(),
  note: z.string().max(300).nullable().optional(),
});

/* ── Techo FIFO (ventana deslizante de 60 s, cola por IP+método) ── */

const WINDOW_MS = 60_000;
const POST_CEILING = 30; // ingestas de un lote real quedan lejos de este techo
const GET_CEILING = 120; // el sondeo del tablero (15 s) usa 4/min
const BUCKET_MAX_IPS = 5_000; // guardia de memoria: IPs simultáneas trackeadas

const buckets = new Map<string, number[]>();

/** Consume un cupo del techo FIFO. false ⇒ excedido (el request NO pasa). */
function takeCeiling(key: string, ceiling: number): boolean {
  const now = Date.now();
  // Guardia de memoria: si el mapa desboca (abuso o spoof de IP), se purga
  // completo — el costo es un techo reiniciado, jamás una fuga sin límite.
  if (buckets.size > BUCKET_MAX_IPS) buckets.clear();
  const queue = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (queue.length >= ceiling) {
    buckets.set(key, queue);
    return false;
  }
  queue.push(now);
  buckets.set(key, queue);
  return true;
}

/** IP del cliente (el gateway Caddy inyecta X-Forwarded-For / X-Real-IP). */
function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'local';
}

export async function POST(req: Request) {
  if (!takeCeiling(`POST:${clientIp(req)}`, POST_CEILING)) {
    return NextResponse.json(
      { ok: false, error: 'Límite de ingesta alcanzado — reintenta en un minuto' },
      { status: 429, headers: { 'Retry-After': '60' } }
    );
  }
  try {
    const body = IngestRecordInput.safeParse(await req.json());
    if (!body.success) {
      return NextResponse.json(
        { ok: false, error: 'Payload inválido', detail: body.error.flatten() },
        { status: 400 }
      );
    }
    const d = body.data;
    const rec = await db.ingestRecord.create({
      data: {
        fileName: d.fileName,
        format: d.format,
        sizeBytes: d.sizeBytes,
        status: d.status,
        entities: d.entities ? JSON.stringify(d.entities) : null,
        crs: d.crs ?? null,
        note: d.note ?? null,
      },
    });
    return NextResponse.json({ ok: true, id: rec.id });
  } catch (err) {
    console.error('[api/ingest] POST falló:', err);
    return NextResponse.json({ ok: false, error: 'Error interno' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  if (!takeCeiling(`GET:${clientIp(req)}`, GET_CEILING)) {
    return NextResponse.json(
      { ok: false, error: 'Límite de consultas alcanzado — reintenta en un minuto' },
      { status: 429, headers: { 'Retry-After': '60' } }
    );
  }
  try {
    const [records, count] = await Promise.all([
      db.ingestRecord.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
      db.ingestRecord.count(),
    ]);
    return NextResponse.json({
      ok: true,
      count,
      records: records.map((r) => ({
        id: r.id,
        fileName: r.fileName,
        format: r.format,
        sizeBytes: r.sizeBytes,
        status: r.status,
        crs: r.crs,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error('[api/ingest] GET falló:', err);
    return NextResponse.json({ ok: false, error: 'Error interno' }, { status: 500 });
  }
}
