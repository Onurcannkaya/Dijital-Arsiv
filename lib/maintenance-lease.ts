/**
 * Uzun süren bakım dilimleri için çökme-kurtarılabilir ve fencing belirteçli
 * kira. `locked_until` yalnız zaman aşımını, `lease_token` ise eski bir
 * Worker'ın yeni sahibin ilerlemesini ezememesini sağlar.
 */

export type MaintenanceLease = {
  taskId: string;
  token: string;
  processed: number;
  total: number | null;
};

export class MaintenanceLeaseLostError extends Error {
  constructor(taskId: string) {
    super(`Bakım işi kirası kaybedildi: ${taskId}`);
    this.name = "MaintenanceLeaseLostError";
  }
}

function lockModifier(lockSeconds: number) {
  const seconds = Math.min(Math.max(Math.trunc(lockSeconds), 30), 3600);
  return `+${seconds} seconds`;
}

export async function claimMaintenanceLease(
  db: D1Database,
  taskId: string,
  lockSeconds: number,
): Promise<MaintenanceLease | null> {
  const token = crypto.randomUUID();
  const row = await db.prepare(`UPDATE maintenance_tasks
    SET status = 'RUNNING', lease_token = ?, locked_until = datetime('now', ?),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('PENDING', 'FAILED', 'RUNNING')
      AND (locked_until IS NULL OR locked_until < datetime('now'))
    RETURNING processed, total`)
    .bind(token, lockModifier(lockSeconds), taskId)
    .first<{ processed: number; total: number | null }>();
  return row ? {
    taskId,
    token,
    processed: Number(row.processed),
    total: row.total === null ? null : Number(row.total),
  } : null;
}

/** Uzun nesne listelerinde her nesne öncesi kirayı uzatır ve sahipliği sınar. */
export async function renewMaintenanceLease(
  db: D1Database,
  lease: MaintenanceLease,
  lockSeconds: number,
) {
  const row = await db.prepare(`UPDATE maintenance_tasks
    SET locked_until = datetime('now', ?), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'RUNNING' AND lease_token = ?
    RETURNING id`).bind(lockModifier(lockSeconds), lease.taskId, lease.token)
    .first<{ id: string }>();
  if (!row) throw new MaintenanceLeaseLostError(lease.taskId);
}

/** Yalnız hâlâ bu kiraya sahip Worker işi FAILED yapabilir. */
export async function failMaintenanceLease(
  db: D1Database,
  lease: MaintenanceLease,
  error: unknown,
) {
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);
  await db.prepare(`UPDATE maintenance_tasks SET status = 'FAILED', lease_token = NULL,
    locked_until = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'RUNNING' AND lease_token = ?`)
    .bind(message, lease.taskId, lease.token).run();
}
