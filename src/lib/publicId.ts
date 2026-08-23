// Public residence ids and the legacy-URL contract.
//
// The old production site's residence URLs (/rentals/<id>) use the Odoo
// product-template id, and those URLs are Google-indexed. Migrated residences
// carry that id in `reference = "ODOO-<odoo id>"`, so:
//   - OUTBOUND: every guest-facing payload exposes the Odoo id as the public
//     id for migrated residences (publicResidenceId), keeping internal links
//     identical to the indexed URLs.
//   - INBOUND: every guest-facing endpoint that receives a residence id
//     resolves it ODOO-reference-first (resolvePublicResidenceId), falling
//     back to the primary key for post-migration residences.
//   - The residences id sequence is bumped past the Odoo id range (see
//     PROGRESS.md) so new rows can never collide with legacy ids.
import { prisma } from "@/lib/prisma";

export function publicResidenceId(residence: { id: number; reference: string | null }): number {
  const ref = residence.reference;
  if (ref?.startsWith("ODOO-")) {
    const n = Number(ref.slice(5));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return residence.id;
}

// Public id -> internal primary key. ODOO reference wins on collision (the
// legacy indexed URLs take priority over accidental internal-id matches).
// A migrated residence is addressable ONLY by its Odoo id — falling back to
// its internal id here would serve the same residence under two URLs
// (duplicate content) and hijack legacy URLs of unmigrated templates, so
// that case resolves to a non-existent id (-> 404 downstream).
export async function resolvePublicResidenceId(publicId: number): Promise<number> {
  const byRef = await prisma.residence.findUnique({
    where: { reference: `ODOO-${publicId}` },
    select: { id: true },
  });
  if (byRef) return byRef.id;

  const byId = await prisma.residence.findUnique({
    where: { id: publicId },
    select: { reference: true },
  });
  if (byId?.reference?.startsWith("ODOO-")) return -1; // public address is its Odoo id
  return publicId;
}
