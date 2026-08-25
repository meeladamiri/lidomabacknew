// Hand-resolved cases in the legacy Odoo location tree, shared by
// check-odoo-location-match.ts and migrate-odoo-locations.ts so the gate and
// the migration can never disagree about them.

/**
 * Odoo has TWO `product_public_category` rows named تهران, both slugged
 * "tehran":
 *
 *   id 1071 — parent = 1 (the root region "اقامتگاه ها"), 1 published listing.
 *             Acts as the province-level container.
 *   id  164 — parent = 1071, 298 published listings. The real city.
 *
 * Odoo's own `x_canonical_category` points BOTH rows at 164, i.e. Odoo already
 * treats the city as the canonical تهران. Our target DB encodes the same
 * shape: province تهران (title_en NULL) -> city تهران (title_en "tehran").
 *
 * So 1071 must map onto the PROVINCE row and must NOT mint a second location
 * carrying the slug "tehran" — /search/tehran has to keep resolving to the
 * city, which is where the listings and the indexed SEO content live.
 */
export const ODOO_ID_IS_PROVINCE_ROW: Record<number, string> = {
  1071: "تهران",
};

/**
 * Categories with no `x_category_type`. Both are junk left over in the Odoo
 * admin rather than real places:
 *
 *   1052 "اجاره ویلا استخردار در ارومیه" (slug "poolurima") — a tag page
 *        mistakenly created as a category; its canonical points at ارومیه and
 *        its generated meta reads "اجاره ویلا و سوئیت در اجاره ویلا استخردار
 *        در ارومیه".
 *   1053 "شوشا" (slug "shusha") — no parent, no listings.
 *
 * Neither was ever migrated, so /search/poolurima and /search/shusha are dead
 * today. They are deliberately NOT created: importing them would turn two dead
 * URLs into live pages carrying malformed titles. Their /tags/… rows keep
 * 301ing exactly as they do now via `legacy_redirects`, which this migration
 * does not touch. Flagged for the team to clean up in Odoo.
 */
export const ODOO_IDS_TO_SKIP = new Set<number>([1052, 1053]);

/**
 * The root container ("اقامتگاه ها"), a region row that is not a real place.
 *
 * It must never become a Location: its slug is "s", which the frontend uses as
 * the "no city selected" sentinel — `getSearchResidences_API_params` sends
 * cat_name "s" for a bare /search, and `getSearchData` forwards that as
 * `slug=s` to /api/search/page-data. A location titled "s" would therefore
 * hand every unscoped /search page the meta title, description and canonical
 * of "اقامتگاه ها". (Search *results* are unaffected either way — buildSearchBody
 * already drops cat_name === "s" before calling the residences endpoint.)
 *
 * It is still needed as a parent sentinel: rows whose parent_id is the root
 * are top-level and get parentId = null.
 */
export const ODOO_ROOT_ID = 1;
