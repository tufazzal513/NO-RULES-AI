/**
 * Admin gate for training / write endpoints.
 * -------------------------------------------
 * When the optional ADMIN_PASSWORD env var is set, every training and
 * data-writing endpoint requires the `x-admin-token` header to match it
 * (constant-time compare). When it is NOT set, the app behaves as before:
 * a single-user self-hosted panel where the owner is the admin.
 *
 * The password itself is never stored in the database, never mirrored to
 * Telegram, and never returned by any endpoint.
 */

import crypto from "crypto";

export interface AdminGate {
  /** True when ADMIN_PASSWORD is configured and endpoints are locked. */
  required: boolean;
  /** Is this token (from the x-admin-token header) accepted? */
  check(token: string | null | undefined): boolean;
}

export function createAdminGate(password?: string | null): AdminGate {
  const secret = password && String(password).trim() ? String(password).trim() : null;
  return {
    required: Boolean(secret),
    check(token) {
      if (!secret) return true;
      if (!token || typeof token !== "string") return false;
      const a = crypto.createHash("sha256").update(token).digest();
      const b = crypto.createHash("sha256").update(secret).digest();
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

/** Pull the token out of the `x-admin-token` header (never from the URL). */
export function adminTokenFrom(req: { header(name: string): string | string[] | undefined }): string | undefined {
  const v = req.header("x-admin-token");
  if (Array.isArray(v)) return v[0];
  return v;
}
